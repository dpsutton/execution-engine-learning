(ns engine.stats
  "Table statistics and selectivity estimation — the planner's only view of the data.

  Per column: rows, nulls, ndv (number of distinct values), min, max, and an equi-depth histogram of
  8 buckets. Equi-depth means every bucket holds (about) the same number of rows, so a skewed column
  gets narrow buckets where values are dense and wide ones where they're sparse."
  (:require [engine.value :as v]))

(def histogram-buckets 8)

(defn- histogram
  "Equi-depth histogram over sorted non-null values: [{:hi upper-bound :count n} …]."
  [sorted]
  (let [n (count sorted)]
    (when (pos? n)
      (vec (for [b (range histogram-buckets)
                 :let [start (quot (* b n) histogram-buckets)
                       end   (quot (* (inc b) n) histogram-buckets)]
                 :when (< start end)]
             {:hi (nth sorted (dec end)) :count (- end start)})))))

(defn column-stats [values]
  (let [non-null (remove nil? values)
        sorted   (vec (sort v/compare-values non-null))]
    {:rows      (count values)
     :nulls     (- (count values) (count sorted))
     :ndv       (count (into #{} (map v/hash-key) sorted))
     :min       (first sorted)
     :max       (peek sorted)
     :histogram (histogram sorted)}))

(defn analyze
  "Compute stats for every column of a table: {:rows n :columns {\"col\" column-stats}}."
  [{:keys [columns rows]}]
  {:rows    (count rows)
   :columns (into {}
                  (map-indexed (fn [i c] [c (column-stats (mapv #(nth % i) rows))]))
                  columns)})

;;; ------------------------------------------------ selectivity -----------------------------------------------

(def default-selectivity
  "What we guess when we know nothing."
  (/ 1.0 3.0))

(defn- fraction-below
  "Estimated fraction of ALL rows (nulls included in the denominator) with value < x (or <= x).
  Walk the histogram; inside the bucket that straddles x, interpolate linearly for numbers."
  [{:keys [rows histogram min]} x inclusive?]
  (if (or (zero? rows) (empty? histogram))
    0.0
    (loop [[{:keys [hi count]} & more] histogram
           lo  min
           acc 0.0]
      (if (nil? hi)
        (/ acc rows)
        (let [c (v/compare-values x hi)]
          (cond
            (or (pos? c) (and (zero? c) inclusive?))
            (recur more hi (+ acc count))

            (and (number? x) (number? lo) (> (double x) (double lo)))
            (/ (+ acc (* count (/ (- (double x) (double lo)) (- (double hi) (double lo))))) rows)

            :else (/ acc rows)))))))

(defn- clamp [x] (max 0.0 (min 1.0 (double x))))

(defn- non-null-fraction [{:keys [rows nulls]}]
  (if (zero? rows) 0.0 (/ (- rows nulls) (double rows))))

(def ^:private flip {:< :>, :<= :>=, :> :<, :>= :<=, := :=, :!= :!=})

(defn selectivity
  "Estimated fraction of rows for which `pred` is true.

  `col-stats` is a function from a bound column name (\"alias.col\") to that column's stats, or nil
  if unknown. Rules (DESIGN.md):

    col = const          1/ndv × non-null fraction
    col < const, …       histogram fraction
    col IS NULL          nulls / rows
    a AND b              s(a)·s(b)           (assumes independence — often wrong, always cheap)
    a OR b               s(a)+s(b)−s(a)s(b)
    NOT a                1 − s(a)
    anything else        1/3"
  [col-stats pred]
  (let [s (partial selectivity col-stats)]
    (clamp
     (case (first pred)
       :and (* (s (nth pred 1)) (s (nth pred 2)))
       :or  (let [a (s (nth pred 1)) b (s (nth pred 2))] (- (+ a b) (* a b)))
       :not (- 1.0 (s (nth pred 1)))
       :is-null     (let [e  (second pred)
                          st (when (= :col (first e)) (col-stats (second e)))]
                      (cond (nil? st)            default-selectivity
                            (zero? (:rows st))   0.0
                            :else                (/ (:nulls st) (double (:rows st)))))
       :is-not-null (- 1.0 (s [:is-null (second pred)]))
       (:= :!= :< :<= :> :>=)
       (let [[op0 a b] pred
             ;; normalize to (col op const)
             [op col lit] (cond (and (= :col (first a)) (= :lit (first b))) [op0 a b]
                                (and (= :lit (first a)) (= :col (first b))) [(flip op0) b a]
                                :else nil)
             st (some-> col second col-stats)
             x  (second lit)]
         (cond
           (and (= op0 :=) (= :col (first a)) (= :col (first b)))
           ;; col = col (a join edge, or two columns of one table): 1/max(ndv)
           (let [na (some-> (col-stats (second a)) :ndv)
                 nb (some-> (col-stats (second b)) :ndv)]
             (if (and na nb) (/ 1.0 (max 1 na nb)) default-selectivity))

           (or (nil? st) (nil? x)) default-selectivity
           (= op :=)  (* (/ 1.0 (max 1 (:ndv st))) (non-null-fraction st))
           (= op :!=) (* (- 1.0 (/ 1.0 (max 1 (:ndv st)))) (non-null-fraction st))
           (= op :<)  (fraction-below st x false)
           (= op :<=) (fraction-below st x true)
           (= op :>)  (- (non-null-fraction st) (fraction-below st x true))
           (= op :>=) (- (non-null-fraction st) (fraction-below st x false))))
       default-selectivity))))
