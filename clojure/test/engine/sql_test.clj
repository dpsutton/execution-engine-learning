(ns engine.sql-test
  (:require [clojure.test :refer [deftest is]]
            [engine.sql :as sql]))

(deftest precedence
  (is (= [:or [:= [:col "a"] [:lit 1]] [:and [:> [:col "b"] [:lit 2]] [:not [:is-null [:col "c"]]]]]
         (:where (sql/parse "select a from t where a = 1 or b > 2 and not c is null"))))
  (is (= [:+ [:lit 1] [:* [:lit 2] [:lit 3]]]
         (:expr (first (:select (sql/parse "select 1 + 2 * 3 from t"))))))
  (is (= [:/ [:* [:col "price"] [:lit 2]] [:lit 4]]
         (:expr (first (:select (sql/parse "select price * 2 / 4 from t")))))))

(deftest select-shape
  (let [stmt (sql/parse "EXPLAIN SELECT c.name AS who, count(*) n FROM customers c JOIN orders o ON o.customer_id = c.id, products WHERE o.qty >= 2 GROUP BY c.name HAVING count(*) > 1 ORDER BY n DESC, who LIMIT 3;")]
    (is (:explain? stmt))
    (is (= [{:expr [:col "c.name"] :alias "who"} {:expr [:agg "count" :*] :alias "n"}] (:select stmt)))
    (is (= [{:table "customers" :alias "c"} {:table "orders" :alias "o"} {:table "products" :alias "products"}] (:from stmt)))
    (is (= [[:= [:col "o.customer_id"] [:col "c.id"]]] (:join-on stmt)))
    (is (= [[:col "c.name"]] (:group-by stmt)))
    (is (= [{:expr [:col "n"] :desc? true} {:expr [:col "who"] :desc? false}] (:order-by stmt)))
    (is (= 3 (:limit stmt)))))

(deftest literals-and-case
  (is (= [[:lit "It's"] [:lit -2] [:lit 1.5] [:lit nil] [:fn "upper" [:col "x"]]]
         (map :expr (:select (sql/parse "SELECT 'It''s', -2, 1.5, NULL, UPPER(X) FROM T"))))))

(deftest render-headers
  (is (= "count(*)" (sql/render [:agg "count" :*])))
  (is (= "coalesce(NULL, name)" (sql/render [:fn "coalesce" [:lit nil] [:col "name"]])))
  (is (= "o.qty * p.price" (sql/render [:* [:col "o.qty"] [:col "p.price"]]))))

(deftest errors-are-readable
  (is (thrown-with-msg? clojure.lang.ExceptionInfo #"expected from" (sql/parse "select a")))
  (is (thrown-with-msg? clojure.lang.ExceptionInfo #"unterminated" (sql/parse "select 'a from t"))))
