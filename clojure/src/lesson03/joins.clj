(ns lesson03.joins
  "Lesson 3 — joins.

  Three ways to find pairs of rows that match:

  - nested loop: for every left row, scan every right row and test the predicate. Works for any
    predicate; costs |L|·|R| comparisons.
  - hash join: read the right side once into a hash table keyed by the join column (the *build*),
    then stream the left side and look each row up (the *probe*). Equality joins only; ~|L|+|R|.
  - sort-merge join: sort both sides on the key, then walk them in step like merging two sorted
    lists. Equality (or range) joins; |L|+|R| after sorting, and free if the inputs are already
    sorted (an index, an earlier ORDER BY).

  Left outer join: every left row appears at least once; a left row with no match is padded with
  NULLs on the right.

  Every join counts the work it does in a `counters` atom so the demo can compare them."
  (:require [clojure.string :as str]))

;;; ------------------------------------------------------------------------------------------------
;;; Values and expressions — compact copy (lessons are standalone)

(defn compare-values
  "Total order for non-NULL values: numbers numerically, strings lexicographically, false < true."
  [a b]
  (if (and (number? a) (number? b))
    (if (and (int? a) (int? b)) (compare (long a) (long b)) (compare (double a) (double b)))
    (compare a b)))

(defn- col-index [schema col-name]
  (let [exact (keep-indexed (fn [i c] (when (= c col-name) i)) schema)
        bare  (keep-indexed (fn [i c] (when (str/ends-with? c (str "." col-name)) i)) schema)]
    (cond (seq exact) (first exact)
          (= 1 (count bare)) (first bare)
          :else (throw (ex-info (str "unknown or ambiguous column " col-name) {:schema schema})))))

(defn compile-expr
  "Compile an expression into (fn [row] value). Supports columns, literals, comparisons, AND/OR,
  arithmetic — enough for join predicates."
  [expr schema]
  (let [[tag a b] expr
        sub #(compile-expr % schema)]
    (case tag
      :col (let [i (col-index schema a)] (fn [row] (nth row i)))
      :lit (fn [_] a)
      (:+ :- :*) (let [l (sub a) r (sub b) op ({:+ + :- - :* *} tag)]
                   (fn [row] (let [x (l row) y (r row)] (when (and (some? x) (some? y)) (op x y)))))
      (:= :!= :< :<= :> :>=)
      (let [l (sub a) r (sub b)
            test ({:= zero? :!= (complement zero?) :< neg? :<= (complement pos?) :> pos? :>= (complement neg?)} tag)]
        (fn [row] (let [x (l row) y (r row)] (when (and (some? x) (some? y)) (test (compare-values x y))))))
      :and (let [l (sub a) r (sub b)]
             (fn [row] (let [x (l row) y (r row)]
                         (cond (or (false? x) (false? y)) false (or (nil? x) (nil? y)) nil :else true)))))))

(defn- hash-key
  "Normalize a join key so equal SQL values are equal map keys (1 and 1.0 must collide)."
  [v]
  (if (and (double? v) (== v (Math/rint v))) (long v) v))

;;; ------------------------------------------------------------------------------------------------
;;; The operator interface (lesson 2) and the basics

(defprotocol Operator
  (open! [op]) (next! [op]) (close! [op]) (schema [op]))

(defn run [op]
  (open! op)
  (try (loop [acc []] (if-let [r (next! op)] (recur (conj acc r)) acc))
       (finally (close! op))))

(defn scan
  "Scan `table` ({:columns :rows}); output columns are named `alias.col`."
  [{:keys [columns rows]} alias]
  (let [pos (volatile! 0)]
    (reify Operator
      (open! [_] (vreset! pos 0))
      (next! [_] (when (< @pos (count rows)) (let [r (nth rows @pos)] (vswap! pos inc) r)))
      (close! [_] nil)
      (schema [_] (mapv #(str alias "." %) columns)))))

(defn sort-op
  "Materialize the child and sort it by `key-expr` ascending, NULLs last. A pipeline breaker:
  nothing comes out until everything has gone in. (Lesson 4 is about sorting properly.)"
  [child key-expr]
  (let [k    (compile-expr key-expr (schema child))
        rows (volatile! nil)]
    (reify Operator
      (open! [_]
        (vreset! rows (seq (sort-by k (fn [a b] (cond (and (nil? a) (nil? b)) 0 (nil? a) 1 (nil? b) -1
                                                       :else (compare-values a b)))
                                    (run child)))))
      (next! [_] (when-let [[r & more] @rows] (vreset! rows more) r))
      (close! [_] (vreset! rows nil))
      (schema [_] (schema child)))))

(defn- pad [n] (vec (repeat n nil)))

;;; ------------------------------------------------------------------------------------------------
;;; Nested loop join

(defn nl-join
  "For each left row, rescan the right child and emit every combination where `pred` is true.
  `kind` is :inner or :left. Counts predicate evaluations as :comparisons."
  [left right pred {:keys [kind counters] :or {kind :inner}}]
  (let [out-schema (into (schema left) (schema right))
        p          (compile-expr pred out-schema)
        width      (count (schema right))
        outer      (volatile! nil)   ; current left row
        matched?   (volatile! false)]
    (reify Operator
      (open! [_] (open! left) (vreset! outer nil))
      (next! [_]
        ;; EXERCISE(nl-join-next): For the current outer (left) row, scan the inner (right) side from the
        ;; top and return each combined row where the predicate is true; then advance the outer row.
        ;; For :left, emit the outer row padded with NULLs if nothing matched. Count each test in :comparisons.
        (loop []
          (if (nil? @outer)
            ;; advance the outer side and restart the inner scan from the top
            (when-let [l (next! left)]
              (vreset! outer l) (vreset! matched? false)
              (close! right) (open! right)
              (recur))
            (if-let [r (next! right)]
              (let [row (into @outer r)]
                (some-> counters (swap! update :comparisons (fnil inc 0)))
                (if (true? (p row))
                  (do (vreset! matched? true) row)
                  (recur)))
              ;; inner exhausted for this outer row
              (let [l @outer]
                (vreset! outer nil)
                (if (and (= kind :left) (not @matched?))
                  (into l (pad width))
                  (recur))))))
        ;; END EXERCISE
        )
      (close! [_] (close! left) (close! right))
      (schema [_] out-schema))))

;;; ------------------------------------------------------------------------------------------------
;;; Hash join

(defn hash-join
  "Build a hash table from the RIGHT child on `right-key`, then probe it with each LEFT row's
  `left-key`. Output is in probe order; matches in build insertion order. NULL keys never match.
  Counts :build-rows, :probes, and :comparisons (candidate rows examined in a bucket)."
  [left right left-key right-key {:keys [kind counters] :or {kind :inner}}]
  (let [out-schema (into (schema left) (schema right))
        lk         (compile-expr left-key (schema left))
        rk         (compile-expr right-key (schema right))
        width      (count (schema right))
        table      (volatile! {})
        pending    (volatile! nil)   ; output rows produced by the current probe
        bump       (fn [k n] (some-> counters (swap! update k (fnil + 0) n)))]
    (reify Operator
      (open! [_]
        ;; EXERCISE(hash-join-build): Drain the right child into @table: a map from (hash-key key) to the
        ;; vector of right rows with that key, in arrival order. Skip NULL keys; count :build-rows.
        (vreset! table
                 (reduce (fn [t row]
                           (bump :build-rows 1)
                           (let [k (rk row)]
                             (if (nil? k) t (update t (hash-key k) (fnil conj []) row))))
                         {} (run right)))
        ;; END EXERCISE
        (vreset! pending nil)
        (open! left))
      (next! [_]
        ;; EXERCISE(hash-join-probe): For each left row, look its key up in @table and emit one joined row
        ;; per match (buffer them in `pending`); pad with NULLs for :left when nothing matched.
        ;; NULL keys never match. Count :probes and :comparisons (bucket size).
        (loop []
          (if-let [[row & more] @pending]
            (do (vreset! pending more) row)
            (when-let [l (next! left)]
              (bump :probes 1)
              (let [k       (lk l)
                    matches (when (some? k) (get @table (hash-key k)))]
                (bump :comparisons (count matches))
                (vreset! pending (cond (seq matches)  (map #(into l %) matches)
                                       (= kind :left) [(into l (pad width))]
                                       :else          nil))
                (recur)))))
        ;; END EXERCISE
        )
      (close! [_] (close! left) (vreset! table {}))
      (schema [_] out-schema))))

;;; ------------------------------------------------------------------------------------------------
;;; Sort-merge join

(defn merge-join
  "Inner equi-join of two inputs ALREADY SORTED on their keys (NULLs last). Walk both sides
  forward: if left key < right key advance left, if greater advance right, if equal emit the left
  row against the whole group of right rows with that key. Counts key :comparisons."
  [left right left-key right-key {:keys [counters]}]
  (let [out-schema (into (schema left) (schema right))
        lk         (compile-expr left-key (schema left))
        rk         (compile-expr right-key (schema right))
        rnext      (volatile! nil)   ; lookahead: first right row not yet grouped
        group      (volatile! [])    ; right rows sharing group-key
        group-key  (volatile! nil)
        pending    (volatile! nil)
        cmp        (fn [a b]
                     (some-> counters (swap! update :comparisons (fnil inc 0)))
                     (cond (nil? b) -1 (nil? a) 1 :else (compare-values a b)))]
    (reify Operator
      (open! [_] (open! left) (open! right)
        (vreset! rnext (next! right)) (vreset! group []) (vreset! group-key nil) (vreset! pending nil))
      (next! [_]
        ;; EXERCISE(merge-join-next): Both inputs are sorted. For each left key, skip right rows with
        ;; smaller keys, gather the group of right rows with an equal key (reuse it if the next left row
        ;; has the same key), and emit the left row joined with each. Compare keys with `cmp`.
        (loop []
          (if-let [[row & more] @pending]
            (do (vreset! pending more) row)
            (when-let [l (next! left)]
              (let [k (lk l)]
                (cond
                  (nil? k) (recur)                       ; NULL never matches
                  ;; same key as the previous left row: reuse the buffered right group
                  (and (some? @group-key) (zero? (cmp k @group-key)))
                  (do (vreset! pending (seq (map #(into l %) @group))) (recur))
                  :else
                  (do
                    ;; skip right rows with smaller keys
                    (while (and @rnext (neg? (cmp (rk @rnext) k)))
                      (vreset! rnext (next! right)))
                    ;; collect the group of right rows equal to k
                    (vreset! group []) (vreset! group-key nil)
                    (while (and @rnext (zero? (cmp (rk @rnext) k)))
                      (vswap! group conj @rnext) (vreset! group-key k)
                      (vreset! rnext (next! right)))
                    (vreset! pending (seq (map #(into l %) @group)))
                    (recur)))))))
        ;; END EXERCISE
        )
      (close! [_] (close! left) (close! right))
      (schema [_] out-schema))))

;;; ------------------------------------------------------------------------------------------------
;;; Data

(def toy
  {:customers {:columns ["id" "name" "city" "age"]
               :rows    [[1 "Ada" "Austin" 36] [2 "Bo" "Boston" nil] [3 "Cy" "Austin" 52] [4 "Di" "Denver" 29]]}
   :orders    {:columns ["id" "customer_id" "product_id" "qty"]
               :rows    [[10 1 100 2] [11 1 101 1] [12 3 100 5] [13 4 102 1] [14 9 101 3]]}})

(defn lcg
  "The shared PRNG from DESIGN.md: a 64-bit LCG. Returns an `intn` function closed over its state."
  [seed]
  (let [state (volatile! (long seed))]
    (fn intn [n]
      (vswap! state #(unchecked-add (unchecked-multiply % 6364136223846793005) 1442695040888963407))
      (mod (unsigned-bit-shift-right @state 33) n))))

(defn generate
  "The generated dataset from DESIGN.md (seed 42): 200 customers, 50 products, 5000 orders."
  []
  (let [intn       (lcg 42)
        cities     ["Austin" "Boston" "Chicago" "Denver" "Miami" "Oakland" "Portland" "Seattle"]
        categories ["books" "games" "garden" "music" "tools"]
        customers  (vec (for [id (range 1 201)]
                          (let [r    (intn 100)
                                city (cond (< r 40) (cities 0) (< r 60) (cities 1) (< r 72) (cities 2)
                                           :else (cities (+ 3 (intn 5))))
                                age  (+ 18 (intn 60))]
                            [id (str "cust" id) city (if (zero? (mod id 17)) nil age)])))
        products   (vec (for [id (range 1 51)]
                          (let [cat (categories (intn 5)) price (/ (double (+ 100 (intn 9900))) 100.0)]
                            [id (str "prod" id) cat price])))
        orders     (vec (for [id (range 1 5001)]
                          (let [r   (intn 100)
                                cid (if (< r 50) (+ 1 (intn 20)) (+ 1 (intn 200)))
                                pid (+ 1 (intn 50))
                                qty (+ 1 (intn 5))
                                day (+ 1 (intn 365))]
                            [id cid pid qty day])))]
    {:customers {:columns ["id" "name" "city" "age"] :rows customers}
     :products  {:columns ["id" "name" "category" "price"] :rows products}
     :orders    {:columns ["id" "customer_id" "product_id" "qty" "day"] :rows orders}}))

;;; ------------------------------------------------------------------------------------------------
;;; Printing + demo

(defn- format-value [v] (cond (nil? v) "NULL" (double? v) (format "%.2f" v) :else (str v)))

(defn print-table [columns rows]
  (let [cells  (cons (vec columns) (map #(mapv format-value %) rows))
        widths (apply map (fn [& col] (apply max (map count col))) cells)
        line   (fn [r] (str/join " | " (map (fn [w c] (format (str "%-" w "s") c)) widths r)))]
    (println (line (first cells)))
    (println (str/join "-+-" (map #(apply str (repeat % "-")) widths)))
    (doseq [r (rest cells)] (println (line r)))))

(defn- header [s] (println) (println (str "== " s " " (apply str (repeat (max 0 (- 70 (count s))) "=")))))

(defn- select-cols [op names]
  (let [s (schema op) idx (mapv #(.indexOf ^java.util.List s %) names)]
    (fn [rows] (mapv (fn [r] (mapv #(nth r %) idx)) rows))))

(defn -main [& _]
  (let [{:keys [customers orders]} toy
        c   #(scan customers "c")
        o   #(scan orders "o")
        on  [:= [:col "c.id"] [:col "o.customer_id"]]
        show ["c.name" "o.id" "o.qty"]]
    (header "Three ways to compute customers ⋈ orders ON c.id = o.customer_id")
    (doseq [[label make] [["Nested loop" (fn [k] (nl-join (c) (o) on {:counters k}))]
                          ["Hash join" (fn [k] (hash-join (c) (o) [:col "c.id"] [:col "o.customer_id"] {:counters k}))]
                          ["Sort-merge" (fn [k] (merge-join (sort-op (c) [:col "c.id"]) (sort-op (o) [:col "o.customer_id"])
                                                            [:col "c.id"] [:col "o.customer_id"] {:counters k}))]]]
      (let [k (atom {:comparisons 0 :build-rows 0 :probes 0}) op (make k) rows (run op)]
        (println)
        (println (str label ":  " (pr-str @k)))
        (print-table show ((select-cols op show) rows))))
    (println)
    (println "Same rows every time (merge emits in key order). The work differs:")
    (println "nested loop compared all 4×5 = 20 pairs; hash built 5 rows and probed 4 times.")

    (header "Left outer join: every customer, matched or not")
    (let [op (hash-join (c) (o) [:col "c.id"] [:col "o.customer_id"] {:kind :left})]
      (print-table show ((select-cols op show) (run op))))
    (println "Bo has no orders, so his order columns are NULL.")
    (println)
    (println "Flip it — orders LEFT JOIN customers — and the orphan order 14 (customer 9) survives:")
    (let [op (nl-join (o) (c) on {:kind :left})]
      (print-table ["o.id" "o.customer_id" "c.name"] ((select-cols op ["o.id" "o.customer_id" "c.name"]) (run op)))))

  (header "At scale: 200 customers ⋈ 5000 orders")
  (let [{:keys [customers orders]} (generate)
        on [:= [:col "c.id"] [:col "o.customer_id"]]]
    (doseq [[label make] [["nested loop" (fn [k] (nl-join (scan customers "c") (scan orders "o") on {:counters k}))]
                          ["hash (build orders)" (fn [k] (hash-join (scan customers "c") (scan orders "o")
                                                                    [:col "c.id"] [:col "o.customer_id"] {:counters k}))]
                          ["hash (build customers)" (fn [k] (hash-join (scan orders "o") (scan customers "c")
                                                                       [:col "o.customer_id"] [:col "c.id"] {:counters k}))]
                          ["sort-merge" (fn [k] (merge-join (sort-op (scan customers "c") [:col "c.id"])
                                                            (sort-op (scan orders "o") [:col "o.customer_id"])
                                                            [:col "c.id"] [:col "o.customer_id"] {:counters k}))]]]
      (let [k (atom {:comparisons 0 :build-rows 0 :probes 0})
            t0 (System/nanoTime)
            n  (count (run (make k)))
            ms (/ (- (System/nanoTime) t0) 1e6)]
        (println (format "  %-22s %5d rows  %9d comparisons  build=%-5d probes=%-4d %8.1f ms"
                         label n (:comparisons @k) (:build-rows @k) (:probes @k) ms))))
    (println)
    (println "Nested loop does |C|·|O| = 1,000,000 comparisons. Hash join touches each row about once.")
    (println "Merge join is linear too, but it paid for two sorts first (not counted here — see lesson 4).")
    (println "The build side matters: hash-join builds on its RIGHT child. Building on 200 customers")
    (println "instead of 5000 orders gives a 25x smaller hash table for the same answer. Picking the")
    (println "build side from estimated row counts is the planner's job (lesson 6).")))
