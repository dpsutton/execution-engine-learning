(ns engine.volcano
  "The iterator executor: every plan node becomes an Operator you pull rows from.

  `open!` allocates state and opens children, `next!` returns the next row vector (or nil when
  exhausted), `close!` releases. Pipeline breakers (hash build, sort, aggregate) do their blocking
  work on the first `next!`. State lives in volatiles inside each `reify` — deliberately the same
  shape as the Go code, and exactly what part 2 of the series builds up."
  (:require [engine.agg :as agg]
            [engine.btree :as btree]
            [engine.expr :as expr]
            [engine.value :as v]))

(defprotocol Operator
  (open! [op])
  (next! [op] "The next row, or nil at the end.")
  (close! [op]))

(defmulti build
  "Plan node → Operator."
  (fn [_catalog node] (:op node)))

(defn- rows-operator
  "An operator over a row sequence computed at open time."
  [rows-fn]
  (let [remaining (volatile! nil)]
    (reify Operator
      (open! [_] (vreset! remaining (seq (rows-fn))))
      (next! [_] (when-let [[r & more] @remaining] (vreset! remaining more) r))
      (close! [_] (vreset! remaining nil)))))

(defmethod build :scan [catalog {:keys [table]}]
  (rows-operator #(get-in catalog [:tables table :rows])))

(defmethod build :index-scan [catalog {:keys [table column lo hi]}]
  (rows-operator (fn []
                   (let [rows (get-in catalog [:tables table :rows])
                         tree (get-in catalog [:indexes (str table "." column)])]
                     (map rows (btree/range-rowids tree lo hi))))))

(defmethod build :filter [catalog {:keys [input pred]}]
  (let [child (build catalog input)
        keep? (expr/compile-predicate (:schema input) pred)]
    (reify Operator
      (open! [_] (open! child))
      (next! [_] (loop [] (when-let [row (next! child)] (if (keep? row) row (recur)))))
      (close! [_] (close! child)))))

(defmethod build :project [catalog {:keys [input exprs]}]
  (let [child (build catalog input)
        fs    (mapv #(expr/compile-expr (:schema input) %) exprs)]
    (reify Operator
      (open! [_] (open! child))
      (next! [_] (when-let [row (next! child)] (mapv #(% row) fs)))
      (close! [_] (close! child)))))

(defmethod build :limit [catalog {:keys [input n]}]
  (let [child (build catalog input)
        left  (volatile! 0)]
    (reify Operator
      (open! [_] (vreset! left n) (open! child))
      (next! [_] (when (pos? @left) (when-let [row (next! child)] (vswap! left dec) row)))
      (close! [_] (close! child)))))

(defmethod build :nl-join [catalog {:keys [left right pred schema]}]
  (let [outer (build catalog left)
        inner (build catalog right)
        keep? (if pred (expr/compile-predicate schema pred) (constantly true))
        cur   (volatile! nil)]
    (reify Operator
      (open! [_] (open! outer) (vreset! cur nil))
      (next! [_]
        (loop []
          (if-let [o @cur]
            (if-let [i (next! inner)]
              (let [row (into o i)] (if (keep? row) row (recur)))
              (do (close! inner) (vreset! cur nil) (recur)))
            (when-let [o (next! outer)]
              ;; rewind the inner side for every outer row
              (open! inner) (vreset! cur o) (recur)))))
      (close! [_] (close! outer)))))

(defmethod build :hash-join [catalog {:keys [left right left-key right-key]}]
  (let [probe   (build catalog left)
        build-s (build catalog right)
        lkey    (expr/compile-expr (:schema left) left-key)
        rkey    (expr/compile-expr (:schema right) right-key)
        table   (volatile! nil)
        pending (volatile! nil)]
    (reify Operator
      (open! [_]
        ;; build phase: drain the right side into key → [rows] (insertion order kept)
        (open! build-s)
        (vreset! table (loop [t {}]
                         (if-let [r (next! build-s)]
                           (let [k (rkey r)]
                             (recur (if (nil? k) t (update t (v/hash-key k) (fnil conj []) r))))
                           t)))
        (close! build-s)
        (open! probe)
        (vreset! pending nil))
      (next! [_]
        ;; probe phase: for each left row, emit it joined with every match
        (loop []
          (if-let [[row & more] @pending]
            (do (vreset! pending more) row)
            (when-let [l (next! probe)]
              (let [k (lkey l)]
                (vreset! pending (when (some? k) (seq (map #(into l %) (get @table (v/hash-key k))))))
                (recur))))))
      (close! [_] (close! probe) (vreset! table nil)))))

(defmethod build :index-nl-join [catalog {:keys [left table column key inner-filter right-schema schema]}]
  (let [outer   (build catalog left)
        rows    (get-in catalog [:tables table :rows])
        tree    (get-in catalog [:indexes (str table "." column)])
        kf      (expr/compile-expr (:schema left) key)
        keep?   (if inner-filter (expr/compile-predicate right-schema inner-filter) (constantly true))
        pending (volatile! nil)]
    (reify Operator
      (open! [_] (open! outer) (vreset! pending nil))
      (next! [_]
        (loop []
          (if-let [[row & more] @pending]
            (do (vreset! pending more) row)
            (when-let [o (next! outer)]
              (vreset! pending (seq (for [rid (btree/lookup tree (kf o))
                                          :let [r (rows rid)]
                                          :when (keep? r)]
                                      (into o r))))
              (recur)))))
      (close! [_] (close! outer)))))

(defmethod build :hash-agg [catalog {:keys [input group-by aggs]}]
  (let [child (build catalog input)
        kfs   (mapv #(expr/compile-expr (:schema input) %) group-by)
        fns   (mapv agg/fn-name aggs)
        afs   (mapv (fn [[_ _ arg]] (if (= :* arg) (constantly 1) (expr/compile-expr (:schema input) arg))) aggs)]
    (rows-operator
     (fn []
       (open! child)
       (let [table (loop [t agg/empty-table]
                     (if-let [row (next! child)]
                       (recur (agg/add-row t fns (mapv #(% row) kfs) (mapv #(% row) afs)))
                       t))]
         (close! child)
         (agg/result-rows table fns (count kfs)))))))

(defmethod build :sort [catalog {:keys [input keys]}]
  (let [child (build catalog input)
        kfs   (mapv #(expr/compile-expr (:schema input) (:expr %)) keys)
        cmp   (v/row-comparator (map-indexed (fn [i k] [i (:desc? k)]) keys))]
    (rows-operator
     (fn []
       (open! child)
       ;; decorate each row with its sort keys, stable-sort, undecorate
       (let [decorated (loop [acc []]
                         (if-let [row (next! child)] (recur (conj acc [(mapv #(% row) kfs) row])) acc))]
         (close! child)
         (map second (sort-by first cmp decorated)))))))

(defn run
  "Execute a plan, returning a vector of row vectors."
  [catalog plan]
  (let [op (build catalog plan)]
    (open! op)
    (try
      (loop [acc []] (if-let [row (next! op)] (recur (conj acc row)) acc))
      (finally (close! op)))))
