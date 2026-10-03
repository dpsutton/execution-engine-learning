(ns engine.golden-test
  "Every golden query must give the same answer on both executors, and the whole report must match
  the checked-in expected output (which is also what the Go engine is diffed against)."
  (:require [clojure.java.io :as io]
            [clojure.string :as str]
            [clojure.test :refer [deftest is testing]]
            [engine.core :as core]
            [engine.data :as data]))

(def golden-sql (slurp (io/file "../queries/golden.sql")))

(deftest volcano-and-vm-agree
  (let [catalog (data/catalog)]
    (doseq [q (core/golden-queries golden-sql)]
      (testing q
        (is (= (core/canonical (core/execute catalog q {:executor :volcano}))
               (core/canonical (core/execute catalog q {:executor :vm}))))))))

(deftest matches-expected-output
  (let [expected (str/trimr (slurp (io/file "test/engine/golden.out")))]
    (doseq [executor [:volcano :vm]]
      (testing executor
        (is (= expected (core/golden-report (data/catalog) golden-sql {:executor executor})))))))
