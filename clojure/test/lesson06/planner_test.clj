(ns lesson06.planner-test
  (:require [clojure.test :refer [deftest is]]
            [lesson06.planner :as p]))

(def db (p/generate))
(def stats (into {} (for [[t tbl] db] [t (p/analyze tbl)])))
(def indexes (p/build-hash-indexes db p/index-names))

(deftest column-stats
  (let [s (p/column-stats [3 1 nil 2 2 nil 5 4 4 4])]
    (is (= {:rows 10 :nulls 2 :ndv 5 :min 1 :max 5} (dissoc s :histogram)))
    (is (= 8 (reduce + (map :count (:histogram s)))))))

(deftest selectivity-rules
  (let [stats-of (fn [col] (get-in stats ["customers" :columns (second (clojure.string/split col #"\."))]))]
    (is (< (Math/abs (- (/ 1.0 8) (p/selectivity stats-of [:= [:col "c.city"] [:lit "Austin"]]))) 1e-9))
    (is (< (Math/abs (- (/ 11.0 200) (p/selectivity stats-of [:is-null [:col "c.age"]]))) 1e-9))
    (is (= (p/selectivity stats-of [:< [:col "c.age"] [:lit 30]])
           (p/selectivity stats-of [:> [:lit 30] [:col "c.age"]])))
    (is (< 0.15 (p/selectivity stats-of [:< [:col "c.age"] [:lit 30]]) 0.25))))

(deftest estimate-helpers
  (is (= 25.0 (p/eq-rows {:rows 5000 :nulls 0 :ndv 200})))
  (is (= 9.0 (p/eq-rows {:rows 100 :nulls 10 :ndv 10})))
  (is (= 0.0 (p/eq-rows {:rows 5 :nulls 5 :ndv 0})))
  (is (= (/ 1.0 200) (p/join-selectivity {:ndv 200} {:ndv 50}))))

(def three-way
  {:relations [{:alias "c" :table "customers"} {:alias "o" :table "orders"} {:alias "p" :table "products"}]
   :where     [[:= [:col "o.customer_id"] [:col "c.id"]]
               [:= [:col "o.product_id"] [:col "p.id"]]
               [:= [:col "c.city"] [:lit "Seattle"]]
               [:= [:col "p.category"] [:lit "games"]]]})

(defn- brute-force [{:keys [where]}]
  (let [{c "customers" o "orders" pr "products"} db]
    (count (for [cr (:rows c) :when (= "Seattle" (nth cr 2))
                 orow (:rows o) :when (= (nth orow 1) (nth cr 0))
                 prow (:rows pr) :when (and (= (nth orow 2) (nth prow 0)) (= "games" (nth prow 2)))]
             1))))

(deftest planned-result-is-correct
  (let [{:keys [plan]} (p/plan-query three-way db stats indexes)
        rows (p/execute plan db indexes (atom {}))]
    (is (= #{"c" "o" "p"} (:aliases plan)))
    (is (= (brute-force three-way) (count rows)))))

(deftest every-join-order-gives-the-same-answer
  ;; force each 2-relation candidate through execute and compare against brute force
  (let [q {:relations [{:alias "c" :table "customers"} {:alias "o" :table "orders"}]
           :where [[:= [:col "o.customer_id"] [:col "c.id"]] [:= [:col "c.city"] [:lit "Seattle"]]]}
        {:keys [plan]} (p/plan-query q db stats indexes)]
    (is (= 622 (count (p/execute plan db indexes (atom {})))))))
