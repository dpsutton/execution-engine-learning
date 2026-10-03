(ns engine.stats-test
  (:require [clojure.test :refer [deftest is testing]]
            [engine.btree :as btree]
            [engine.data :as data]
            [engine.stats :as stats]))

(deftest dataset-shape
  (let [{:keys [tables]} (data/catalog)]
    (is (= 200 (count (get-in tables ["customers" :rows]))))
    (is (= 50 (count (get-in tables ["products" :rows]))))
    (is (= 5000 (count (get-in tables ["orders" :rows]))))
    (testing "every 17th customer has a NULL age"
      (is (= (set (range 17 201 17))
             (set (for [[id _ _ age] (get-in tables ["customers" :rows]) :when (nil? age)] id)))))
    (testing "generation is deterministic"
      (is (= (data/generate) (data/generate))))))

(deftest lcg-matches-the-spec
  ;; state1 = 42 * 6364136223846793005 + 1442695040888963407 mod 2^64, then >>> 33
  (let [expected (-> (biginteger 42) (.multiply (biginteger 6364136223846793005))
                     (.add (biginteger 1442695040888963407))
                     (.mod (.shiftLeft BigInteger/ONE 64))
                     (.shiftRight 33) long)]
    (is (= expected ((:next (data/lcg 42)))))))

(deftest column-stats
  (let [st (get-in (data/catalog) [:stats "customers" :columns "age"])]
    (is (= 200 (:rows st)))
    (is (= 11 (:nulls st)))
    (is (= (- 200 11) (reduce + (map :count (:histogram st)))) "histogram covers every non-null value")
    (is (= 8 (count (:histogram st))))
    (is (= (:max st) (:hi (peek (:histogram st)))))))

(deftest selectivity-estimates
  (let [catalog   (data/catalog)
        col-stats (fn [c] (get-in catalog [:stats "customers" :columns (subs c (inc (.indexOf ^String c ".")))]))
        sel       #(stats/selectivity col-stats %)]
    (is (= (/ 1.0 200) (sel [:= [:col "c.id"] [:lit 7]])))
    (is (< 0.02 (sel [:<= [:col "c.id"] [:lit 5]]) 0.03))
    (is (< 0.45 (sel [:< [:col "c.id"] [:lit 100]]) 0.55))
    (is (= (sel [:> [:col "c.id"] [:lit 100]]) (sel [:< [:lit 100] [:col "c.id"]])) "literal on the left flips")
    (is (= (/ 11.0 200) (sel [:is-null [:col "c.age"]])))
    (is (= stats/default-selectivity (sel [:= [:fn "lower" [:col "c.name"]] [:lit "x"]])))))

(deftest btree-agrees-with-brute-force
  (let [rows  (get-in (data/catalog) [:tables "orders" :rows])
        tree  (get-in (data/catalog) [:indexes "orders.customer_id"])
        brute (fn [pred] (vec (sort-by (juxt #(nth (rows %) 1) identity)
                                       (filter #(pred (nth (rows %) 1)) (range (count rows))))))]
    (is (> (btree/depth tree) 1))
    (is (= (brute #(= % 7)) (btree/lookup tree 7)))
    (is (= [] (btree/lookup tree 9999)))
    (is (= (brute #(<= 10 % 30)) (btree/range-rowids tree {:value 10 :inclusive? true} {:value 30 :inclusive? true})))
    (is (= (brute #(< 10 % 30)) (btree/range-rowids tree {:value 10 :inclusive? false} {:value 30 :inclusive? false})))
    (is (= (brute #(> % 190)) (btree/range-rowids tree {:value 190 :inclusive? false} nil)))))
