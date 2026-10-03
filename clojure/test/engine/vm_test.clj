(ns engine.vm-test
  (:require [clojure.test :refer [deftest is testing]]
            [engine.compiler :as compiler]
            [engine.core :as core]
            [engine.data :as data]
            [engine.vm :as vm]))

(defn- program-for [sql]
  (compiler/compile-plan (:plan (core/prepare (data/catalog) sql))))

(defn- run-interrupted
  "Run a program `fuel` instructions at a time, serializing the whole machine to an EDN string and
  reading it back between every slice — as if each slice ran in a different process."
  [program catalog fuel]
  (loop [snap (vm/snapshot (vm/initial-state program)) rows [] slices 0]
    (let [{:keys [status row state]} (vm/step program catalog (vm/restore snap) fuel)]
      (case status
        :row         (recur (vm/snapshot state) (conj rows row) (inc slices))
        :out-of-fuel (recur (vm/snapshot state) rows (inc slices))
        :done        {:rows rows :slices slices}))))

(deftest snapshot-restore-resumes-exactly
  (let [catalog (data/catalog)]
    (doseq [sql ["SELECT c.name, count(*) AS n FROM customers c JOIN orders o ON o.customer_id = c.id GROUP BY c.name ORDER BY n DESC, c.name LIMIT 5"
                 "SELECT c.name, o.day FROM customers c JOIN orders o ON o.customer_id = c.id WHERE c.city = 'Seattle' AND o.qty = 5 ORDER BY o.day DESC, c.name LIMIT 8"
                 "SELECT p.name, o.qty FROM products p, orders o WHERE o.product_id = p.id AND o.day = 17 ORDER BY p.name, o.qty"]]
      (testing sql
        (let [program  (program-for sql)
              expected (vm/run program catalog)
              {:keys [rows slices]} (run-interrupted program catalog 37)]
          (is (seq expected))
          (is (= expected rows))
          (is (> slices 10) "it really was interrupted many times"))))))

(deftest fuel-is-counted-per-instruction
  (let [program (program-for "SELECT id FROM products WHERE id = 3")
        {:keys [status state]} (vm/step program (data/catalog) (vm/initial-state program) 1)]
    (is (= :out-of-fuel status))
    (is (= 1 (:pc state)) "Init jumped to 1 and stopped")))

(deftest limit-exits-early
  (let [program (program-for "SELECT id FROM orders LIMIT 3")]
    (is (= [[1] [2] [3]] (vm/run program (data/catalog))))))

(deftest empty-aggregate-still-returns-a-row
  (let [catalog (data/catalog)
        sql     "SELECT count(*), sum(qty) FROM orders WHERE qty > 100"]
    (is (= [[0 nil]] (:rows (core/execute catalog sql {:executor :vm}))))
    (is (= [[0 nil]] (:rows (core/execute catalog sql {:executor :volcano}))))))
