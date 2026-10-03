(ns engine.expr
  "Working with (bound) expressions: walking them, and compiling them into closures.

  After binding, every [:col name] holds a fully qualified \"alias.col\", and a row's schema is the
  vector of those names. Compiling resolves each name to a vector index once, up front, so
  evaluating against a row is just closure calls — no name lookups and no `case` per row."
  (:require [engine.value :as v]))

(defn children
  "Sub-expressions of e."
  [e]
  (case (first e)
    (:col :lit) []
    :fn  (nnext e)
    :agg (if (= :* (nth e 2)) [] [(nth e 2)])
    (rest e)))

(defn columns
  "Every column name referenced by e."
  [e]
  (if (= :col (first e))
    #{(second e)}
    (into #{} (mapcat columns) (children e))))

(defn alias-of [column-name] (subs column-name 0 (.indexOf ^String column-name ".")))

(defn aliases
  "The relation aliases e reads from."
  [e]
  (into #{} (map alias-of) (columns e)))

(defn aggregates
  "The aggregate calls inside e, outermost first, without duplicates."
  [e]
  (if (= :agg (first e))
    [e]
    (into [] (comp (mapcat aggregates) (distinct)) (children e))))

(defn substitute
  "Rewrite e top-down: wherever (lookup subexpr) is non-nil, replace the whole subtree with it."
  [lookup e]
  (or (lookup e)
      (case (first e)
        (:col :lit :agg) e
        :fn (into [:fn (second e)] (map #(substitute lookup %)) (nnext e))
        (into [(first e)] (map #(substitute lookup %)) (rest e)))))

(defn conjuncts
  "Split a predicate on AND: (a AND (b AND c)) → [a b c]."
  [e]
  (cond (nil? e)           []
        (= :and (first e)) (into (conjuncts (nth e 1)) (conjuncts (nth e 2)))
        :else              [e]))

(defn conjoin
  "Inverse of `conjuncts`. nil for no predicates."
  [es]
  (when (seq es) (reduce (fn [a b] [:and a b]) es)))

(defn column-index
  "Position of a column in a schema, or an error naming what was available."
  ^long [schema name]
  (let [i (.indexOf ^java.util.List schema name)]
    (if (neg? i)
      (throw (ex-info (str "no column " name " in " schema) {:schema schema :name name}))
      i)))

(defn compile-expr
  "Compile a bound expression against a schema into (fn [row] value)."
  [schema e]
  (case (first e)
    :col (let [i (column-index schema (second e))] (fn [row] (nth row i)))
    :lit (let [x (second e)] (fn [_] x))
    :not (let [f (compile-expr schema (second e))] (fn [row] (v/not3 (f row))))
    :is-null     (let [f (compile-expr schema (second e))] (fn [row] (nil? (f row))))
    :is-not-null (let [f (compile-expr schema (second e))] (fn [row] (some? (f row))))
    :fn  (let [name (second e)
               fs   (mapv #(compile-expr schema %) (nnext e))]
           (fn [row] (v/call-function name (mapv #(% row) fs))))
    :agg (throw (ex-info "aggregate outside of an aggregation" {:expr e}))
    (let [op (or (v/binary-ops (first e)) (throw (ex-info (str "unknown operator " (first e)) {:expr e})))
          l  (compile-expr schema (nth e 1))
          r  (compile-expr schema (nth e 2))]
      (fn [row] (op (l row) (r row))))))

(defn compile-predicate
  "Like compile-expr but returns (fn [row] boolean): only exactly-true passes."
  [schema e]
  (let [f (compile-expr schema e)] (fn [row] (v/truthy? (f row)))))
