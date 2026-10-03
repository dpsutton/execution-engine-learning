(ns engine.agg
  "Hash aggregation as plain data, shared by the Volcano operator and the VM's Agg* instructions.

  A group table is

    {:index  {[normalized key values] group-number}
     :groups [[key-values [accumulator …]] …]}      ; first-seen order

  Accumulators are plain values ([sum n] for avg), so the whole table survives a VM snapshot."
  (:require [engine.value :as v]))

(defn init [f]
  (case f
    ("count" "count*") 0
    ("sum" "min" "max") nil
    "avg" [nil 0]))

(defn step
  "Fold one input value into an accumulator. NULL inputs are ignored except by count(*)."
  [f acc x]
  (case f
    "count*" (inc acc)
    "count"  (if (nil? x) acc (inc acc))
    "sum"    (cond (nil? x) acc (nil? acc) x :else (v/add acc x))
    "min"    (cond (nil? x) acc (or (nil? acc) (neg? (v/compare-values x acc))) x :else acc)
    "max"    (cond (nil? x) acc (or (nil? acc) (pos? (v/compare-values x acc))) x :else acc)
    "avg"    (let [[s n] acc] (if (nil? x) acc [(if (nil? s) x (v/add s x)) (inc n)]))))

(defn finish [f acc]
  (case f
    "avg" (let [[s n] acc] (when (pos? n) (/ (double s) n)))
    acc))

(def empty-table {:index {} :groups []})

(defn add-row
  "Fold one row's group key values and aggregate input values into the table."
  [table fns key-values input-values]
  (let [k (mapv v/hash-key key-values)
        i (get (:index table) k)]
    (if (nil? i)
      (let [accs (mapv (fn [f x] (step f (init f) x)) fns input-values)]
        (-> table
            (assoc-in [:index k] (count (:groups table)))
            (update :groups conj [(vec key-values) accs])))
      (update-in table [:groups i 1] (fn [accs] (mapv step fns accs input-values))))))

(defn result-rows
  "Output rows: group key values followed by finished aggregates, in first-seen order.
  With no GROUP BY, an empty input still produces one row (count(*) = 0, sum = NULL, …)."
  [table fns n-keys]
  (if (and (empty? (:groups table)) (zero? n-keys))
    [(mapv #(finish % (init %)) fns)]
    (mapv (fn [[ks accs]] (into ks (map finish fns accs))) (:groups table))))

(defn fn-name
  "The accumulator name for an [:agg …] expression: count(*) is its own function."
  [[_ f arg]]
  (if (= :* arg) "count*" f))
