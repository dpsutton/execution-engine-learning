(ns engine.planner
  "From a parsed statement to a physical plan.

    bind      resolve every column name to \"alias.col\"
    classify  split WHERE + ON into conjuncts; single-relation ones are pushed down to that relation,
              `a.x = b.y` ones become join edges, the rest are residual filters
    access    per relation, choose a full Scan (+ Filter) or an IndexScan on an indexed predicate
    join      Selinger-style dynamic programming over subsets of relations, left-deep, choosing
              hash / nested-loop / index nested-loop for each join by estimated cost
    finish    HashAggregate → Filter (HAVING) → Sort → Limit → Project

  A physical plan is a tree of maps. Every node carries :op, :schema (its output column names),
  :est (estimated rows) and :cost (estimated cumulative cost, in rows touched)."
  (:require [clojure.string :as str]
            [engine.expr :as expr]
            [engine.sql :as sql]
            [engine.stats :as stats]))

;;; -------------------------------------------------- binding -------------------------------------------------

(defn- relations
  "FROM list → [{:table :alias :columns [\"alias.col\" …]}], checked against the catalog."
  [catalog from]
  (reduce (fn [rels {:keys [table alias]}]
            (let [t (get-in catalog [:tables table])]
              (when-not t (throw (ex-info (str "unknown table " table) {:table table})))
              (when (some #(= alias (:alias %)) rels)
                (throw (ex-info (str "duplicate table alias " alias) {:alias alias})))
              (conj rels {:table table :alias alias :columns (mapv #(str alias "." %) (:columns t))})))
          [] from))

(defn- resolve-column
  "`c.name` must name an alias and one of its columns; a bare `name` must be unambiguous."
  [rels name]
  (if (str/includes? name ".")
    (if (some #(some #{name} (:columns %)) rels)
      name
      (throw (ex-info (str "unknown column " name) {:column name})))
    (let [hits (for [r rels c (:columns r) :when (= c (str (:alias r) "." name))] c)]
      (case (count hits)
        0 (throw (ex-info (str "unknown column " name) {:column name}))
        1 (first hits)
        (throw (ex-info (str "ambiguous column " name " (could be " (str/join ", " hits) ")") {:column name}))))))

(defn- bind
  "Rewrite every column reference in e to its qualified name."
  [rels e]
  (case (first e)
    :col [:col (resolve-column rels (second e))]
    :lit e
    :agg (if (= :* (nth e 2)) e [:agg (second e) (bind rels (nth e 2))])
    :fn  (into [:fn (second e)] (map #(bind rels %)) (nnext e))
    (into [(first e)] (map #(bind rels %)) (rest e))))

(defn- bind-or-alias
  "ORDER BY / GROUP BY may name a SELECT alias. ORDER BY prefers the alias (output column) and GROUP
  BY prefers the input column, as in Postgres."
  [rels select e prefer-alias?]
  (let [alias-hit (when (and (= :col (first e)) (not (str/includes? (second e) ".")))
                    (some #(when (= (second e) (:alias %)) (:expr %)) select))]
    (if (and alias-hit prefer-alias?)
      alias-hit
      (try (bind rels e)
           (catch clojure.lang.ExceptionInfo ex
             (or alias-hit (throw ex)))))))

;;; ------------------------------------------------ estimation ------------------------------------------------

(defn- log2 [x] (/ (Math/log (max 2.0 (double x))) (Math/log 2.0)))

(defn- stats-lookup
  "A function from \"alias.col\" to that column's stats."
  [catalog rels]
  (let [table-of (into {} (map (juxt :alias :table)) rels)]
    (fn [column-name]
      (let [alias (expr/alias-of column-name)
            col   (subs column-name (inc (count alias)))]
        (get-in catalog [:stats (table-of alias) :columns col])))))

(defn- selectivity [col-stats preds]
  (reduce * 1.0 (map #(stats/selectivity col-stats %) preds)))

;;; --------------------------------------------- access paths -------------------------------------------------

(def ^:private flip {:< :>, :<= :>=, :> :<, :>= :<=, := :=})

(defn- index-bounds
  "If pred is `col op literal` (either way round) on rel's column with an index, return
  {:column c :lo bound :hi bound}. Bounds are {:value v :inclusive? bool} or nil (unbounded)."
  [catalog rel pred]
  (let [[op a b] pred
        [op col lit] (cond (and (= :col (first a)) (= :lit (first b))) [op a b]
                           (and (= :lit (first a)) (= :col (first b))) [(flip op) b a]
                           :else nil)
        column (when col (subs (second col) (inc (count (:alias rel)))))
        x      (second lit)]
    (when (and column (some? x) (#{:= :< :<= :> :>=} op)
               (get-in catalog [:indexes (str (:table rel) "." column)]))
      {:column column
       :lo (case op (:= :>= :>) {:value x :inclusive? (not= op :>)} nil)
       :hi (case op (:= :<= :<) {:value x :inclusive? (not= op :<)} nil)})))

(defn- with-filter
  "Put a Filter over node when there are predicates left to apply."
  [node preds est]
  (if (empty? preds)
    node
    {:op :filter :pred (expr/conjoin preds) :input node :schema (:schema node)
     :est est :cost (+ (:cost node) (:est node))}))

(defn- access-path
  "Cheapest way to read one relation with its pushed-down predicates: Scan + Filter, or IndexScan on
  one indexable predicate + Filter for the rest."
  [catalog col-stats rel preds]
  (let [rows  (get-in catalog [:stats (:table rel) :rows])
        est   (* rows (selectivity col-stats preds))
        scan  {:op :scan :table (:table rel) :alias (:alias rel) :schema (:columns rel) :est rows :cost rows}
        plans (cons (with-filter scan preds est)
                    (for [p preds
                          :let [bounds (index-bounds catalog rel p)]
                          :when bounds
                          :let [matched (* rows (stats/selectivity col-stats p))
                                iscan   (merge {:op :index-scan :table (:table rel) :alias (:alias rel)
                                                :schema (:columns rel) :est matched
                                                :cost (+ (log2 rows) matched)}
                                               bounds)]]
                      (with-filter iscan (remove #{p} preds) est)))]
    (apply min-key :cost (reverse plans))))   ; reverse: on a tie, `min-key` keeps the last → the first plan

;;; ------------------------------------------------ join ordering ---------------------------------------------

(defn- equi-edge
  "If pred is `x.a = y.b` with x ≠ y, return it as an edge {:pred :cols {alias column-name}}."
  [pred]
  (let [[op a b] pred]
    (when (and (= op :=) (= :col (first a)) (= :col (first b)))
      (let [aa (expr/alias-of (second a)) ab (expr/alias-of (second b))]
        (when (not= aa ab) {:pred pred :cols {aa (second a) ab (second b)}})))))

(defn- bits [n mask] (filter #(bit-test mask %) (range n)))

(defn- join-candidates
  "Every way to join `left` (the best plan for a subset) with relation `rel`."
  [{:keys [catalog col-stats access pushed]} left rel edges residuals]
  (let [right        (access (:alias rel))
        schema       (into (:schema left) (:schema right))
        edge-sel     #(stats/selectivity col-stats (:pred %))
        all-sel      (* (reduce * 1.0 (map edge-sel edges)) (selectivity col-stats residuals))
        est          (* (:est left) (:est right) all-sel)
        rows         (get-in catalog [:stats (:table rel) :rows])
        ;; hash / index joins use one edge as the key; any other edges become a filter on top
        keyed        (fn [node edge key-sel]
                       (let [rest-preds (concat (map :pred (remove #{edge} edges)) residuals)
                             join-est   (* (:est left) (:est right) key-sel)]
                         (with-filter (assoc node :schema schema :est join-est) rest-preds est)))]
    (concat
     ;; nested loop: re-run the inner plan once per outer row
     [(with-filter {:op :nl-join :left left :right right
                    :pred (expr/conjoin (map :pred edges)) :schema schema
                    :est (* (:est left) (:est right) (reduce * 1.0 (map edge-sel edges)))
                    :cost (+ (:cost left) (* (max 1.0 (:est left)) (:cost right)))}
                   residuals est)]
     ;; hash join: build a table on the right (base relation), probe it with each left row
     (for [e edges]
       (keyed {:op :hash-join :left left :right right
               :left-key [:col (get (:cols e) (first (remove #{(:alias rel)} (keys (:cols e)))))]
               :right-key [:col (get (:cols e) (:alias rel))]
               :cost (+ (:cost left) (:cost right) (* 2 (:est right)) (:est left))}
              e (edge-sel e)))
     ;; index nested loop: look each left row's key up in an index on the right relation
     (for [e edges
           :let [rcol   (get (:cols e) (:alias rel))
                 column (subs rcol (inc (count (:alias rel))))]
           :when (get-in catalog [:indexes (str (:table rel) "." column)])
           :let [ndv     (max 1 (:ndv (col-stats rcol)))
                 inner   (pushed (:alias rel))]]
       (keyed {:op :index-nl-join :left left :table (:table rel) :alias (:alias rel) :column column
               :key [:col (get (:cols e) (first (remove #{(:alias rel)} (keys (:cols e)))))]
               :inner-filter (expr/conjoin inner)
               :right-schema (:columns rel)
               :cost (+ (:cost left) (* (max 1.0 (:est left)) (+ (log2 rows) (/ rows ndv))))}
              e (edge-sel e))))))

(defn- order-joins
  "Selinger DP: best[S] = cheapest over r ∈ S of join(best[S − r], r). Left-deep (the right side
  of every join is a single relation), so 2^n subsets × n choices — fine for a handful of tables."
  [{:keys [rels access edges residuals] :as ctx}]
  (let [n     (count rels)
        alias #(:alias (rels %))
        full  (dec (bit-shift-left 1 n))
        masks (sort-by (juxt #(Long/bitCount %) identity) (range 1 (inc full)))]
    (get
     (reduce
      (fn [best mask]
        (let [members (bits n mask)]
          (if (= 1 (count members))
            (assoc best mask (access (alias (first members))))
            (let [cands (for [i members
                              :let [lmask   (bit-clear mask i)
                                    left    (best lmask)
                                    lset    (set (map alias (bits n lmask)))
                                    r       (alias i)
                                    between (filter #(let [ks (set (keys (:cols %)))]
                                                       (and (ks r) (some lset ks))) edges)
                                    covered (filter #(let [as (expr/aliases %)]
                                                       (and (contains? as r) (every? (conj lset r) as)))
                                                    residuals)]]
                          (join-candidates ctx left (rels i) between covered))]
              (assoc best mask (apply min-key :cost (reverse (apply concat cands))))))))
      {} masks)
     full)))

;;; ------------------------------------------------- planning -------------------------------------------------

(defn- aggregate-node
  "Estimated groups = product of the group columns' distinct counts, capped by the input rows."
  [col-stats input group-keys aggs]
  (let [ndv (fn [e] (if (= :col (first e)) (or (some-> (col-stats (second e)) :ndv) 10) 10))]
    {:op :hash-agg :input input :group-by group-keys :aggs aggs
     :schema (mapv sql/render (concat group-keys aggs))
     :est (if (empty? group-keys) 1.0 (min (:est input) (double (reduce * 1 (map ndv group-keys)))))
     :cost (+ (:cost input) (:est input))}))

(defn plan
  "Statement → {:plan physical-plan :columns output-names}."
  [catalog stmt]
  (let [rels      (relations catalog (:from stmt))
        select    (if (= :star (:select stmt))
                    (vec (for [r rels c (:columns r)]
                           {:expr [:col c] :name (subs c (inc (count (:alias r))))}))
                    ;; header: the alias, else a bare column name (`c.name` → `name`, as Postgres
                    ;; does), else the expression's text (`count(*)`)
                    (mapv (fn [{:keys [expr alias]}]
                            {:expr (bind rels expr) :alias alias
                             :name (or alias
                                       (when (= :col (first expr)) (last (str/split (second expr) #"\.")))
                                       (sql/render expr))})
                          (:select stmt)))
        preds     (mapv #(bind rels %) (mapcat expr/conjuncts (cons (:where stmt) (:join-on stmt))))
        group-keys (vec (distinct (map #(bind-or-alias rels select % false) (:group-by stmt))))
        having    (some->> (:having stmt) (bind rels))
        order-by  (mapv #(update % :expr (fn [e] (bind-or-alias rels select e true))) (:order-by stmt))

        ;; classify predicates
        col-stats (stats-lookup catalog rels)
        by-alias  (group-by (fn [p] (let [as (expr/aliases p)] (when (= 1 (count as)) (first as)))) preds)
        pushed    (dissoc by-alias nil)
        multi     (get by-alias nil)
        edges     (keep equi-edge multi)
        residuals (remove (set (map :pred edges)) multi)
        constants (filter #(empty? (expr/aliases %)) residuals)
        residuals (remove (set constants) residuals)
        access    (into {} (for [r rels]
                             [(:alias r) (access-path catalog col-stats r (get pushed (:alias r)))]))
        joined    (order-joins {:catalog catalog :col-stats col-stats :rels rels :access access
                                :pushed pushed :edges edges :residuals residuals})
        joined    (with-filter joined constants (:est joined))

        ;; aggregation: replace group keys and aggregate calls above it by references to its output
        aggs      (vec (distinct (mapcat expr/aggregates (concat (map :expr select)
                                                                 (some-> having vector)
                                                                 (map :expr order-by)))))
        grouped?  (or (seq group-keys) (seq aggs))
        node      (if grouped? (aggregate-node col-stats joined group-keys aggs) joined)
        rewrite   (if grouped?
                    (let [outputs (set (concat group-keys aggs))]
                      (fn [e]
                        (let [e' (expr/substitute #(when (outputs %) [:col (sql/render %)]) e)]
                          (doseq [c (expr/columns e')]
                            (when-not (some #{c} (:schema node))
                              (throw (ex-info (str "column " c " must appear in GROUP BY or inside an aggregate")
                                              {:column c}))))
                          e')))
                    identity)
        node      (if having
                    (let [est (* (:est node) stats/default-selectivity)]
                      (with-filter node [(rewrite having)] est))
                    node)
        node      (if (seq order-by)
                    {:op :sort :input node :schema (:schema node) :est (:est node)
                     :keys (mapv #(update % :expr rewrite) order-by)
                     :cost (+ (:cost node) (* (:est node) (log2 (:est node))))}
                    node)
        node      (if (:limit stmt)
                    {:op :limit :input node :n (:limit stmt) :schema (:schema node)
                     :est (min (:est node) (double (:limit stmt))) :cost (:cost node)}
                    node)
        names     (mapv :name select)]
    {:columns names
     :plan    {:op :project :input node :exprs (mapv (comp rewrite :expr) select) :schema names
               :est (:est node) :cost (:cost node)}}))

;;; -------------------------------------------------- EXPLAIN -------------------------------------------------

(defn- bound-text [{:keys [value inclusive?]} lower?]
  (str (if lower? (if inclusive? ">= " "> ") (if inclusive? "<= " "< ")) (sql/render [:lit value])))

(defn describe
  "One line for a plan node, without its children."
  [node]
  (case (:op node)
    :scan          (str "Scan " (:table node) (when (not= (:alias node) (:table node)) (str " AS " (:alias node))))
    :index-scan    (let [{:keys [lo hi]} node]
                     (str "IndexScan " (:table node) (when (not= (:alias node) (:table node)) (str " AS " (:alias node)))
                          " USING " (:table node) "." (:column node) " ("
                          (if (and lo hi (= (:value lo) (:value hi)) (:inclusive? lo) (:inclusive? hi))
                            (str "= " (sql/render [:lit (:value lo)]))
                            (str/join " AND " (remove nil? [(some-> lo (bound-text true)) (some-> hi (bound-text false))])))
                          ")"))
    :filter        (str "Filter " (sql/render (:pred node)))
    :nl-join       (str "NestedLoopJoin" (when (:pred node) (str " ON " (sql/render (:pred node)))))
    :hash-join     (str "HashJoin " (sql/render [:= (:left-key node) (:right-key node)]) "   (probe left, build right)")
    :index-nl-join (str "IndexNestedLoopJoin " (:table node) (when (not= (:alias node) (:table node)) (str " AS " (:alias node)))
                        " USING " (:table node) "." (:column node) " = " (sql/render (:key node))
                        (when (:inner-filter node) (str " FILTER " (sql/render (:inner-filter node)))))
    :hash-agg      (str "HashAggregate"
                        (when (seq (:group-by node)) (str " GROUP BY " (str/join ", " (map sql/render (:group-by node)))))
                        " → " (str/join ", " (map sql/render (:aggs node))))
    :sort          (str "Sort " (str/join ", " (map #(str (sql/render (:expr %)) (when (:desc? %) " DESC")) (:keys node))))
    :limit         (str "Limit " (:n node))
    :project       (str "Project " (str/join ", " (map sql/render (:exprs node))))))

(defn inputs [node]
  (case (:op node)
    (:scan :index-scan) []
    (:nl-join :hash-join) [(:left node) (:right node)]
    [(:left node (:input node))]))

(defn explain
  "The plan as an indented tree, with estimated rows and cost on every line."
  [plan]
  (let [lines (volatile! [])]
    (letfn [(walk [node depth]
              (vswap! lines conj (format "%-70s rows≈%-8s cost≈%s"
                                         (str (apply str (repeat depth "  ")) (when (pos? depth) "└ ") (describe node))
                                         (Math/round (double (:est node)))
                                         (Math/round (double (:cost node)))))
              (doseq [c (inputs node)] (walk c (inc depth))))]
      (walk plan 0))
    (str/join "\n" @lines)))
