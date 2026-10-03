(ns lesson06.planner
  "Lesson 6 — statistics, estimates, cost, and choosing a plan.

  A planner can't run every possible plan to see which is fastest, so it guesses:

  1. ANALYZE: summarize each column once — row count, NULL count, number of distinct values
     (ndv), min/max, and an equi-depth histogram (8 buckets holding ~equal numbers of rows).
  2. Selectivity: the fraction of rows a predicate keeps, estimated from those stats
     (`col = c` → 1/ndv, ranges → histogram, AND → multiply, assuming independence).
  3. Cardinality: rows out of each plan node. For an equi-join, |L|·|R| / max(ndv(a), ndv(b)).
  4. Cost: rough work units per operator, driven by the cardinalities.
  5. Search: Selinger-style dynamic programming. Best plan for every 1-relation set, then every
     2-relation set built from the best smaller ones, and so on — choosing the join algorithm
     (hash / nested loop / index nested loop) at each step.

  Then we execute the chosen plan and print estimated vs actual rows for every node. The gaps are
  the lesson: uniformity and independence assumptions are wrong on skewed data, and the plan is
  only as good as the estimates."
  (:require [clojure.string :as str]))

;;; ------------------------------------------------------------------------------------------------
;;; Values and expressions (compact copy)

(defn compare-values [a b]
  (if (and (number? a) (number? b))
    (if (and (int? a) (int? b)) (compare (long a) (long b)) (compare (double a) (double b)))
    (compare a b)))

(defn- col-index [schema col-name]
  (let [i (.indexOf ^java.util.List schema col-name)]
    (if (neg? i) (throw (ex-info (str "unknown column " col-name) {:schema schema})) i)))

(defn compile-expr [expr schema]
  (let [[tag a b] expr
        sub #(compile-expr % schema)]
    (case tag
      :col (let [i (col-index schema a)] (fn [row] (nth row i)))
      :lit (fn [_] a)
      (:= :!= :< :<= :> :>=)
      (let [l (sub a) r (sub b)
            test ({:= zero? :!= (complement zero?) :< neg? :<= (complement pos?) :> pos? :>= (complement neg?)} tag)]
        (fn [row] (let [x (l row) y (r row)] (when (and (some? x) (some? y)) (test (compare-values x y))))))
      :and (let [l (sub a) r (sub b)]
             (fn [row] (let [x (l row) y (r row)]
                         (cond (or (false? x) (false? y)) false (or (nil? x) (nil? y)) nil :else true))))
      :or (let [l (sub a) r (sub b)]
            (fn [row] (let [x (l row) y (r row)]
                        (cond (or (true? x) (true? y)) true (or (nil? x) (nil? y)) nil :else false))))
      :not (let [e (sub a)] (fn [row] (let [x (e row)] (when (some? x) (not x)))))
      :is-null (let [e (sub a)] (fn [row] (nil? (e row))))
      :is-not-null (let [e (sub a)] (fn [row] (some? (e row)))))))

(defn expr->sql [expr]
  (let [[tag a b] expr]
    (case tag
      :col a
      :lit (if (string? a) (str "'" a "'") (str a))
      :is-null (str (expr->sql a) " IS NULL")
      :is-not-null (str (expr->sql a) " IS NOT NULL")
      :not (str "NOT " (expr->sql a))
      (:and :or) (str "(" (expr->sql a) " " (str/upper-case (name tag)) " " (expr->sql b) ")")
      (str (expr->sql a) " " (name tag) " " (expr->sql b)))))

(defn- columns-of
  "Every column name an expression references."
  [expr]
  (if (= :col (first expr)) #{(second expr)} (into #{} (mapcat columns-of (filter vector? (rest expr))))))

(defn- alias-of [col] (first (str/split col #"\." 2)))
(defn- bare-col [col] (second (str/split col #"\." 2)))

;;; ------------------------------------------------------------------------------------------------
;;; 1. ANALYZE

(defn column-stats
  "Summarize one column. The histogram is equi-DEPTH: each of the 8 buckets holds about the same
  number of rows, so dense value ranges get narrow buckets and sparse ranges wide ones."
  [values]
  (let [non-null (vec (sort compare-values (remove nil? values)))
        n        (count non-null)
        buckets  8]
    {:rows      (count values)
     :nulls     (- (count values) n)
     :ndv       (count (distinct non-null))
     :min       (first non-null)
     :max       (peek non-null)
     :histogram (vec (for [b (range buckets)
                           :let [from (quot (* b n) buckets) to (quot (* (inc b) n) buckets)]
                           :when (< from to)]
                       {:lo (non-null from) :hi (non-null (dec to)) :count (- to from)}))}))

(defn analyze
  "Stats for every column of a table: {:rows n :columns {\"city\" {...}}}."
  [{:keys [columns rows]}]
  {:rows    (count rows)
   :columns (into {} (map-indexed (fn [i c] [c (column-stats (map #(nth % i) rows))]) columns))})

;;; ------------------------------------------------------------------------------------------------
;;; 2. Selectivity

(def ^:const unknown-selectivity (/ 1.0 3))

(defn- rows-below
  "Estimated number of rows with value < v (strictly), from the histogram. Whole buckets below v
  count fully; the bucket containing v contributes a linearly interpolated part (numbers only —
  for strings, half the bucket)."
  [{:keys [histogram]} v]
  ;; EXERCISE(range-selectivity): Sum the histogram: buckets entirely below v count fully, buckets at or
  ;; above v count nothing, and the bucket straddling v counts the fraction of its [lo, hi] span below v.
  (reduce (fn [acc {:keys [lo hi count]}]
            (cond
              (neg? (compare-values hi v)) (+ acc count)                     ; bucket entirely below
              (>= (compare-values lo v) 0) acc                                ; entirely at/above
              (and (number? lo) (number? hi) (not= lo hi))
              (+ acc (* count (/ (- (double v) lo) (- (double hi) lo))))
              :else (+ acc (/ count 2.0))))
          0.0 histogram)
  ;; END EXERCISE
  )

(defn eq-rows
  "Estimated rows matching `col = <some constant>`: the uniformity assumption."
  [{:keys [rows nulls ndv]}]
  ;; EXERCISE(eq-selectivity): Assume every distinct non-NULL value is equally common: non-NULL rows
  ;; spread evenly over ndv values (0.0 when there are no distinct values).
  (if (zero? ndv) 0.0 (/ (double (- rows nulls)) ndv))
  ;; END EXERCISE
  )

(defn join-selectivity
  "Fraction of the |L|·|R| pairs an equi-join `l = r` keeps, from the two columns' stats."
  [lstats rstats]
  ;; EXERCISE(join-cardinality): Each value on the side with fewer distinct values finds its partners on
  ;; the other side: 1 / max(ndv(l), ndv(r)) (guard against 0).
  (/ 1.0 (max 1 (:ndv lstats) (:ndv rstats)))
  ;; END EXERCISE
  )

(defn selectivity
  "Fraction of rows (0..1) that `pred` keeps, given `stats-of`: column name → column stats."
  [stats-of pred]
  (let [[tag a b] pred
        col+lit   (fn [] (cond (and (= :col (first a)) (= :lit (first b))) [(second a) (second b) tag]
                               (and (= :lit (first a)) (= :col (first b)))
                               [(second b) (second a) ({:< :> :<= :>= :> :< :>= :<= := := :!= :!=} tag)]))]
    (case tag
      :and (* (selectivity stats-of a) (selectivity stats-of b))           ; independence assumption
      :or  (let [x (selectivity stats-of a) y (selectivity stats-of b)] (- (+ x y) (* x y)))
      :not (- 1.0 (selectivity stats-of a))
      (:is-null :is-not-null)
      (if-let [s (and (= :col (first a)) (stats-of (second a)))]
        (let [f (/ (double (:nulls s)) (max 1 (:rows s)))] (if (= tag :is-null) f (- 1.0 f)))
        unknown-selectivity)
      (:= :!= :< :<= :> :>=)
      (if-let [[col v op] (col+lit)]
        (let [{:keys [rows nulls ndv] :as s} (stats-of col)
              rows     (max 1 rows)
              non-null (- rows nulls)
              eq       (eq-rows s)                                    ; rows per distinct value
              below    (rows-below s v)
              est      (case op
                         :=  eq
                         :!= (- non-null eq)
                         :<  below
                         :<= (+ below eq)
                         :>  (- non-null below eq)
                         :>= (- non-null below))]
          (min 1.0 (max 0.0 (/ est rows))))
        unknown-selectivity)
      unknown-selectivity)))

;;; ------------------------------------------------------------------------------------------------
;;; The query and its pieces

(defn- equi-join-pred?
  "Is `pred` `a.x = b.y` with two different relations? Those become join edges."
  [[tag a b]]
  (and (= tag :=) (= :col (first a)) (= :col (first b))
       (not= (alias-of (second a)) (alias-of (second b)))))

(defn- conjuncts [pred] (if (= :and (first pred)) (mapcat conjuncts (rest pred)) [pred]))

(defn- ctx
  "Everything the planner needs: relation info, stats, indexes, classified predicates."
  [{:keys [relations where]} db stats indexes]
  (let [preds (mapcat conjuncts where)]
    {:relations (into {} (map (fn [{:keys [alias table]}] [alias table]) relations))
     :aliases   (mapv :alias relations)
     :db db :stats stats :indexes indexes
     :stats-of  (fn [col]
                  (let [table (some #(when (= (:alias %) (alias-of col)) (:table %)) relations)]
                    (get-in stats [table :columns (bare-col col)])))
     :local     (group-by #(alias-of (first (columns-of %)))
                          (filter #(= 1 (count (set (map alias-of (columns-of %))))) preds))
     :edges     (filter equi-join-pred? preds)
     :residual  (filter #(and (not (equi-join-pred? %)) (< 1 (count (set (map alias-of (columns-of %)))))) preds)}))

;;; ------------------------------------------------------------------------------------------------
;;; 3–4. Access paths, joins, cardinality, cost

(defn- log2 [x] (/ (Math/log (max 2.0 x)) (Math/log 2.0)))

(defn- access-plans
  "Ways to read one relation: a full scan + filter, or — when a local predicate is `col = const`
  on an indexed column — an index lookup + the remaining filter."
  [{:keys [relations stats stats-of local indexes]} alias]
  (let [table  (relations alias)
        base   (get-in stats [table :rows])
        preds  (local alias)
        sel    (reduce * 1.0 (map #(selectivity stats-of %) preds))
        est    (* base sel)
        scan   {:op :scan :alias alias :table table :filters preds :aliases #{alias}
                :est est :cost (+ base (if (seq preds) base 0))}
        lookup (for [[tag a b :as p] preds
                     :when (and (= tag :=) (= :col (first a)) (= :lit (first b))
                                (contains? indexes (str table "." (bare-col (second a)))))]
                 (let [matched (* base (selectivity stats-of p))]
                   {:op :index-scan :alias alias :table table :column (bare-col (second a)) :key (second b)
                    :filters (remove #{p} preds) :aliases #{alias}
                    :est est :cost (+ (log2 base) matched)}))]
    (cons scan lookup)))

(defn- join-candidates
  "Every way to join the best plan for `left` with relation `r` (whose best access plan is
  `rplan`). Returns plans with :est and :cost filled in."
  [{:keys [relations stats stats-of edges residual indexes]} lplan rplan r]
  (let [laliases (:aliases lplan)
        my-edges (for [[_ [_ x] [_ y] :as e] edges
                       :let [[lcol rcol] (cond (and (laliases (alias-of x)) (= r (alias-of y))) [x y]
                                               (and (laliases (alias-of y)) (= r (alias-of x))) [y x])]
                       :when lcol]
                   {:pred e :lcol lcol :rcol rcol})
        all      (conj laliases r)
        resid    (filter #(and (every? all (map alias-of (columns-of %)))
                               (not-every? laliases (map alias-of (columns-of %)))
                               (not (every? #{r} (map alias-of (columns-of %)))))
                         residual)
        join-sel (reduce * 1.0 (concat
                                (for [{:keys [lcol rcol]} my-edges]
                                  (join-selectivity (stats-of lcol) (stats-of rcol)))
                                (repeat (count resid) unknown-selectivity)))
        est      (* (:est lplan) (:est rplan) join-sel)
        base     {:aliases all :est est :edges my-edges :residual resid}
        L (:est lplan) R (:est rplan)
        children-cost (+ (:cost lplan) (:cost rplan))]
    (concat
     (when (seq my-edges)
       [(merge base {:op :hash-join :probe lplan :build rplan :cost (+ children-cost (* 2 R) L)})
        (merge base {:op :hash-join :probe rplan :build lplan :cost (+ children-cost (* 2 L) R)})])
     [(merge base {:op :nl-join :outer lplan :inner rplan :cost (+ children-cost (* L R))})]
     ;; index NL: the inner side must be a base-table scan with an index on its join column
     (for [{:keys [rcol] :as e} my-edges
           :let [table (relations r)]
           :when (and (= :scan (:op rplan)) (contains? indexes (str table "." (bare-col rcol))))]
       (let [inner-rows (get-in stats [table :rows])
             matches    (/ (double inner-rows) (max 1 (:ndv (stats-of rcol))))]
         (merge base {:op :index-nl-join :outer lplan :inner rplan :index-edge e
                      :cost (+ (:cost lplan) (* L (+ (log2 inner-rows) matches)))}))))))

;;; ------------------------------------------------------------------------------------------------
;;; 5. Dynamic programming over subsets

(defn- subsets-of-size [xs k]
  (cond (zero? k) [#{}]
        (empty? xs) []
        :else (concat (map #(conj % (first xs)) (subsets-of-size (rest xs) (dec k)))
                      (subsets-of-size (rest xs) k))))

(defn plan-query
  "Selinger DP. `best` maps a set of aliases to the cheapest plan joining exactly those relations.
  Size-1 sets get the best access path; a size-k set tries every way of adding one relation r to
  the best plan for (set − r) — a left-deep search. Cross products are only considered when a set
  has no join edge at all. Returns {:plan … :table best :considered n}."
  [query db stats indexes]
  (let [c       (ctx query db stats indexes)
        aliases (:aliases c)
        best1   (into {} (for [a aliases] [#{a} (apply min-key :cost (access-plans c a))]))
        considered (volatile! 0)
        best
                ;; EXERCISE(join-order-dp): Starting from best1 (one relation each), for k = 2..n and every
                ;; k-subset s, try adding each r in s to the best plan for (s − r) via join-candidates; prefer
                ;; candidates with a join edge; keep the cheapest per s. Count candidates in `considered`.
                (reduce
                 (fn [best k]
                   (reduce (fn [best s]
                             (let [cands (for [r s
                                               :let [lp (best (disj s r))]
                                               :when lp
                                               cand (join-candidates c lp (best #{r}) r)]
                                           cand)
                                   linked (filter #(seq (:edges %)) cands)
                                   cands  (if (seq linked) linked cands)]
                               (vswap! considered + (count cands))
                               (if (seq cands) (assoc best s (apply min-key :cost cands)) best)))
                           best (subsets-of-size aliases k)))
                 best1 (range 2 (inc (count aliases))))
                ;; END EXERCISE
                ]
    {:plan (best (set aliases)) :table best :considered @considered :ctx c}))

;;; ------------------------------------------------------------------------------------------------
;;; Execution (just enough operators to run a plan and count actual rows per node)

(defprotocol Operator
  (open! [op]) (next! [op]) (close! [op]) (schema [op]))

(defn- run [op]
  (open! op)
  (try (loop [acc []] (if-let [r (next! op)] (recur (conj acc r)) acc))
       (finally (close! op))))

(defn- from-rows [rows out-schema]
  (let [rem (volatile! nil)]
    (reify Operator
      (open! [_] (vreset! rem (seq rows)))
      (next! [_] (when-let [[r & more] @rem] (vreset! rem more) r))
      (close! [_] nil)
      (schema [_] out-schema))))

(defn- counted
  "Wrap an operator so it records how many rows it produced under `id` in `actuals`."
  [op actuals id]
  (reify Operator
    (open! [_] (swap! actuals assoc id 0) (open! op))
    (next! [_] (let [r (next! op)] (when r (swap! actuals update id inc)) r))
    (close! [_] (close! op))
    (schema [_] (schema op))))

(defn- filter-rows [rows out-schema preds]
  (if (empty? preds)
    rows
    (let [p (compile-expr (reduce (fn [a b] [:and a b]) preds) out-schema)]
      (filter #(true? (p %)) rows))))

(defn build-hash-indexes
  "Stand-in indexes: column value → row ids. (Lesson 5 has the real B+tree; the planner only
  needs to know an index exists and what a lookup costs.)"
  [db index-names]
  (into {} (for [n index-names
                 :let [[table col] (str/split n #"\." 2)
                       {:keys [columns rows]} (db table)
                       i (.indexOf ^java.util.List columns col)]]
             [n (reduce (fn [m [id row]] (update m (nth row i) (fnil conj []) id))
                        {} (map-indexed vector rows))])))

(defn- edge-keys [edges probe-schema]
  (let [pset (set probe-schema)]
    (mapv (fn [{:keys [lcol rcol]}] (if (pset lcol) [lcol rcol] [rcol lcol])) edges)))

(defn execute
  "Build operators for `plan` and run them. Every node's output is counted in `actuals`, keyed by
  the node itself (plans are values, so a node is its own id)."
  [plan db indexes actuals]
  (letfn [(build [node]
            (let [qualify (fn [alias table] (mapv #(str alias "." %) (:columns (db table))))
                  op
                  (case (:op node)
                    :scan
                    (let [{:keys [alias table filters]} node s (qualify alias table)]
                      (from-rows (filter-rows (:rows (db table)) s filters) s))
                    :index-scan
                    (let [{:keys [alias table column key filters]} node s (qualify alias table)
                          rows (:rows (db table))
                          ids  (get-in indexes [(str table "." column) key])]
                      (from-rows (filter-rows (map #(nth rows %) ids) s filters) s))
                    :hash-join
                    (let [probe (build (:probe node)) build-op (build (:build node))
                          s     (into (schema probe) (schema build-op))
                          ks    (edge-keys (:edges node) (schema probe))
                          pk    (mapv (fn [[p _]] (compile-expr [:col p] (schema probe))) ks)
                          bk    (mapv (fn [[_ b]] (compile-expr [:col b] (schema build-op))) ks)
                          table (group-by (fn [r] (mapv #(% r) bk)) (run build-op))
                          ;; NULL keys never match: a key containing nil finds nothing
                          out   (for [l (run probe)
                                      :let [k (mapv #(% l) pk)]
                                      :when (not-any? nil? k)
                                      r (get table k)]
                                  (into l r))]
                      (from-rows (filter-rows out s (:residual node)) s))
                    :nl-join
                    (let [outer (build (:outer node)) inner (run (build (:inner node)))
                          s     (into (schema outer) (schema (build (:inner node))))
                          preds (concat (map :pred (:edges node)) (:residual node))]
                      (from-rows (filter-rows (for [l (run outer) r inner] (into l r)) s preds) s))
                    :index-nl-join
                    (let [outer (build (:outer node))
                          {:keys [alias table filters]} (:inner node)
                          {:keys [lcol rcol]} (:index-edge node)
                          s     (into (schema outer) (qualify alias table))
                          ok    (compile-expr [:col lcol] (schema outer))
                          idx   (indexes (str table "." (bare-col rcol)))
                          rows  (:rows (db table))
                          inner-ok (let [is (qualify alias table)] (fn [r] (seq (filter-rows [r] is filters))))
                          out   (for [l (run outer) id (get idx (ok l)) :let [r (nth rows id)] :when (inner-ok r)]
                                  (into l r))
                          other (concat (map :pred (remove #{(:index-edge node)} (:edges node))) (:residual node))]
                      ;; the inner scan never runs as its own operator; record its matches for EXPLAIN
                      (from-rows (filter-rows out s other) s)))]
              (counted op actuals node)))]
    (run (build plan))))

;;; ------------------------------------------------------------------------------------------------
;;; EXPLAIN

(defn- describe [node]
  (case (:op node)
    :scan       (str "Scan " (:table node) " " (:alias node)
                     (when (seq (:filters node)) (str "  filter: " (str/join " AND " (map expr->sql (:filters node))))))
    :index-scan (str "IndexScan " (:table node) " " (:alias node) " on " (:column node) " = " (pr-str (:key node))
                     (when (seq (:filters node)) (str "  filter: " (str/join " AND " (map expr->sql (:filters node))))))
    :hash-join  (str "HashJoin " (str/join " AND " (map (comp expr->sql :pred) (:edges node))) "  (build ↓2nd)")
    :nl-join    (if (seq (:edges node))
                  (str "NestedLoopJoin " (str/join " AND " (map (comp expr->sql :pred) (:edges node))))
                  "NestedLoopJoin (cross product: no join predicate)")
    :index-nl-join (str "IndexNestedLoopJoin " (expr->sql (:pred (:index-edge node)))
                        "  via index on " (:table (:inner node)) "." (bare-col (:rcol (:index-edge node))))))

(defn- children [node]
  (case (:op node)
    :hash-join [(:probe node) (:build node)]
    (:nl-join :index-nl-join) [(:outer node) (:inner node)]
    []))

(defn explain
  "Plan tree, one node per line: estimated rows, actual rows (if `actuals` given), and cost."
  ([plan] (explain plan nil))
  ([plan actuals]
   (let [lines (atom [])]
     (letfn [(walk [node depth]
               (let [act (when actuals (get actuals node))
                     inner-of-inl? (and (= :scan (:op node)) actuals (nil? act))]
                 (swap! lines conj
                        (format "%-78s est=%8.1f %s cost=%9.1f"
                                (str (apply str (repeat depth "  ")) (describe node)
                                     (when inner-of-inl? "  (probed via index)"))
                                (double (:est node))
                                (if actuals (format "actual=%5s" (if act (str act) "—")) "")
                                (double (:cost node))))
                 (doseq [c (children node)] (walk c (inc depth)))))]
       (walk plan 0))
     (str/join "\n" @lines))))

;;; ------------------------------------------------------------------------------------------------
;;; Data

(defn lcg [seed]
  (let [state (volatile! (long seed))]
    (fn intn [n]
      (vswap! state #(unchecked-add (unchecked-multiply % 6364136223846793005) 1442695040888963407))
      (mod (unsigned-bit-shift-right @state 33) n))))

(defn generate []
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
    {"customers" {:columns ["id" "name" "city" "age"] :rows customers}
     "products"  {:columns ["id" "name" "category" "price"] :rows products}
     "orders"    {:columns ["id" "customer_id" "product_id" "qty" "day"] :rows orders}}))

(def index-names #{"customers.id" "products.id" "orders.id" "orders.customer_id" "orders.product_id"})

;;; ------------------------------------------------------------------------------------------------
;;; Demo

(defn- header [s] (println) (println (str "== " s " " (apply str (repeat (max 0 (- 70 (count s))) "=")))))

(defn- fmt [v] (cond (nil? v) "NULL" (double? v) (format "%.2f" v) :else (str v)))

(defn- print-histogram [{:keys [histogram rows]}]
  (doseq [{:keys [lo hi count]} histogram]
    (println (format "    [%5s .. %5s] %4d %s" (fmt lo) (fmt hi) count
                     (apply str (repeat (Math/round (/ (* 40.0 count) rows)) "█"))))))

(defn -main [& _]
  (let [db      (generate)
        stats   (into {} (for [[t tbl] db] [t (analyze tbl)]))
        indexes (build-hash-indexes db index-names)]

    (header "ANALYZE")
    (doseq [t ["customers" "orders"]]
      (println (format "%s: %d rows" t (get-in stats [t :rows])))
      (doseq [[c s] (get-in stats [t :columns])]
        (println (format "  %-12s nulls=%-3d ndv=%-5d min=%-8s max=%s" c (:nulls s) (:ndv s) (fmt (:min s)) (fmt (:max s))))))
    (println)
    (println "customers.age — equi-depth histogram (each bucket ≈ same row count; widths vary):")
    (print-histogram (get-in stats ["customers" :columns "age"]))
    (println)
    (println "orders.customer_id — half the orders go to customers 1–20, so the first buckets are narrow:")
    (print-histogram (get-in stats ["orders" :columns "customer_id"]))

    (header "Estimated vs actual selectivity")
    (let [tbls {"c" "customers" "o" "orders" "p" "products"}
          stats-of (fn [col] (get-in stats [(tbls (alias-of col)) :columns (bare-col col)]))]
      (println (format "  %-40s %8s %8s  %s" "predicate" "est" "actual" "why"))
      (doseq [[pred why] [[[:= [:col "c.city"] [:lit "Austin"]] "1/ndv assumes 8 equally common cities; Austin is 40%"]
                          [[:= [:col "c.city"] [:lit "Seattle"]] "…so the rare ones are overestimated"]
                          [[:< [:col "c.age"] [:lit 30]] "histogram: good"]
                          [[:is-null [:col "c.age"]] "null count: exact"]
                          [[:= [:col "o.customer_id"] [:lit 7]] "skew: customers 1–20 are hot"]
                          [[:= [:col "o.customer_id"] [:lit 150]] "…and the rest are cold"]
                          [[:<= [:col "o.day"] [:lit 30]] "uniform data: histogram nails it"]
                          [[:and [:= [:col "o.qty"] [:lit 5]] [:> [:col "o.day"] [:lit 300]]] "independent columns: product rule works"]]]
        (let [t     (tbls (alias-of (first (columns-of pred))))
              {:keys [columns rows]} (db t)
              s     (mapv #(str (alias-of (first (columns-of pred))) "." %) columns)
              p     (compile-expr pred s)
              est   (* (count rows) (selectivity stats-of pred))
              act   (count (filter #(true? (p %)) rows))]
          (println (format "  %-40s %8.1f %8d  %s" (expr->sql pred) est act why)))))

    (let [query {:relations [{:alias "c" :table "customers"} {:alias "o" :table "orders"} {:alias "p" :table "products"}]
                 :where     [[:= [:col "o.customer_id"] [:col "c.id"]]
                             [:= [:col "o.product_id"] [:col "p.id"]]
                             [:= [:col "c.city"] [:lit "Seattle"]]
                             [:= [:col "p.category"] [:lit "games"]]]}
          {:keys [plan table considered]} (plan-query query db stats indexes)]
      (header "Join ordering: customers ⋈ orders ⋈ products")
      (println "WHERE o.customer_id = c.id AND o.product_id = p.id AND c.city = 'Seattle' AND p.category = 'games'")
      (println)
      (println "DP table — the best plan found for each set of relations:")
      (doseq [[s p] (sort-by (fn [[s p]] [(count s) (:cost p)]) table)]
        (println (format "  %-10s %-72s est=%8.1f cost=%9.1f" (str "{" (str/join "," (sort s)) "}")
                         (describe p) (double (:est p)) (double (:cost p)))))
      (println (format "  (%d join candidates costed)" considered))
      (println)
      (let [actuals (atom {})
            rows    (execute plan db indexes actuals)]
        (println "Chosen plan, estimated vs actual rows:")
        (println (explain plan @actuals))
        (println)
        (println (format "%d result rows. The plan starts from the most selective relations and" (count rows)))
        (println "reaches orders through an index, never scanning all 5000 rows.")))

    (let [query {:relations [{:alias "c" :table "customers"} {:alias "o" :table "orders"}]
                 :where     [[:= [:col "o.customer_id"] [:col "c.id"]]
                             [:= [:col "c.id"] [:lit 7]]]}
          {:keys [plan]} (plan-query query db stats indexes)
          actuals (atom {})]
      (header "Point lookup + join")
      (println "WHERE o.customer_id = c.id AND c.id = 7")
      (execute plan db indexes actuals)
      (println (explain plan @actuals))
      (println)
      (println "Estimate for customer 7's orders is 25 (5000/200 distinct). Actual is 126: customer 7")
      (println "is one of the hot ones. Uniformity is the planner's most common wrong assumption."))))
