(ns engine.data
  "The generated dataset and the catalog that holds it.

  The data comes from a 64-bit linear congruential generator specified in DESIGN.md. The Go engine
  runs the same generator, so both engines see byte-identical tables and the golden queries can be
  diffed across languages."
  (:require [engine.btree :as btree]
            [engine.stats :as stats]))

;;; --------------------------------------------------- PRNG ---------------------------------------------------

(defn lcg
  "A tiny stateful PRNG: `next` returns a value in [0, 2^31). Uses unchecked math so the multiply
  wraps mod 2^64 exactly like Go's uint64, and an unsigned shift so the sign bit doesn't leak in."
  [seed]
  (let [state (volatile! (long seed))]
    {:next (fn []
             (let [s (unchecked-add (unchecked-multiply ^long @state 6364136223846793005)
                                    1442695040888963407)]
               (vreset! state s)
               (unsigned-bit-shift-right s 33)))}))

(defn intn
  "A random long in [0, n)."
  [rng n]
  (mod ((:next rng)) n))

;;; ------------------------------------------------- tables ---------------------------------------------------

(def cities     ["Austin" "Boston" "Chicago" "Denver" "Miami" "Oakland" "Portland" "Seattle"])
(def categories ["books" "games" "garden" "music" "tools"])

(defn- gen-customers [rng]
  (vec (for [id (range 1 201)]
         ;; `for` is lazy but `vec` realizes it in order, so the draws happen in DESIGN.md order.
         (let [name (str "cust" id)
               r    (intn rng 100)
               city (cond (< r 40) (cities 0)
                          (< r 60) (cities 1)
                          (< r 72) (cities 2)
                          :else    (cities (+ 3 (intn rng 5))))
               age  (+ 18 (intn rng 60))]
           [(long id) name city (if (zero? (mod id 17)) nil age)]))))

(defn- gen-products [rng]
  (vec (for [id (range 1 51)]
         (let [category (categories (intn rng 5))
               price    (/ (double (+ 100 (intn rng 9900))) 100.0)]
           [(long id) (str "prod" id) category price]))))

(defn- gen-orders [rng]
  (vec (for [id (range 1 5001)]
         (let [r           (intn rng 100)
               customer-id (if (< r 50) (+ 1 (intn rng 20)) (+ 1 (intn rng 200)))
               product-id  (+ 1 (intn rng 50))
               qty         (+ 1 (intn rng 5))
               day         (+ 1 (intn rng 365))]
           [(long id) customer-id product-id qty day]))))

(def index-columns
  "Which columns get a B+tree index."
  [["customers" "id"] ["products" "id"] ["orders" "id"] ["orders" "customer_id"] ["orders" "product_id"]])

(def index-order 32)

(defn build-catalog
  "A catalog is plain data:

    {:tables  {\"orders\" {:name \"orders\" :columns [\"id\" …] :rows [[…] …]}}
     :indexes {\"orders.customer_id\" <b+tree of value → [row ids]>}
     :stats   {\"orders\" <table stats>}}

  A row id is the row's position in :rows."
  [tables]
  (let [tables  (into {} (map (juxt :name identity)) tables)
        indexes (into {}
                      (for [[t c] index-columns
                            :let  [table (tables t)]
                            :when table
                            :let  [i (.indexOf ^java.util.List (:columns table) c)]]
                        [(str t "." c)
                         (reduce-kv (fn [tree rowid row] (btree/insert tree (nth row i) rowid))
                                    (btree/empty-tree index-order)
                                    (:rows table))]))]
    {:tables  tables
     :indexes indexes
     :stats   (update-vals tables stats/analyze)}))

(defn generate
  "Generate the three tables from one PRNG stream, in DESIGN.md order."
  ([] (generate 42))
  ([seed]
   (let [rng (lcg seed)]
     ;; let* evaluates in order, which fixes the draw order customers → products → orders.
     (let [customers (gen-customers rng)
           products  (gen-products rng)
           orders    (gen-orders rng)]
       [{:name "customers" :columns ["id" "name" "city" "age"] :rows customers}
        {:name "products" :columns ["id" "name" "category" "price"] :rows products}
        {:name "orders" :columns ["id" "customer_id" "product_id" "qty" "day"] :rows orders}]))))

(defonce ^{:doc "The default catalog, built once."} default-catalog
  (delay (build-catalog (generate))))

(defn catalog [] @default-catalog)
