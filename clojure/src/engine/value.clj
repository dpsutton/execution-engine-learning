(ns engine.value
  "SQL values and their semantics, shared by every part of the engine.

  A value is one of: nil (NULL), long, double, String, Boolean. A row is a vector of values.
  Everything here is a pure function so the Volcano executor and the bytecode VM can't disagree
  about what `1 + NULL` or `'a' < 'b'` means."
  (:import (java.math BigDecimal RoundingMode)))

;;; ------------------------------------------------ arithmetic ------------------------------------------------

(defn- arith
  "Integer op if both sides are longs, float op otherwise. NULL in, NULL out."
  [long-op double-op a b]
  (cond
    (or (nil? a) (nil? b))      nil
    (and (int? a) (int? b))     (long-op (long a) (long b))
    :else                       (double-op (double a) (double b))))

(defn add [a b] (arith + + a b))
(defn sub [a b] (arith - - a b))
(defn mul [a b] (arith * * a b))

(defn div
  "`/` always returns a float. Division by zero is NULL rather than an error."
  [a b]
  (cond
    (or (nil? a) (nil? b)) nil
    (zero? (double b))     nil
    :else                  (/ (double a) (double b))))

;;; ------------------------------------------------ comparison ------------------------------------------------

(defn compare-values
  "Total order over two non-NULL values of compatible kinds: -1, 0 or 1.
  Numbers compare numerically (longs and doubles mix), strings by code unit, false < true."
  ^long [a b]
  (cond
    (and (number? a) (number? b))   (Long/signum (long (compare (double a) (double b))))
    (and (string? a) (string? b))   (Long/signum (long (compare ^String a ^String b)))
    (and (boolean? a) (boolean? b)) (compare a b)
    :else (throw (ex-info (str "cannot compare " (pr-str a) " with " (pr-str b)) {:a a :b b}))))

(defn- cmp
  "Lift a comparison of two values into SQL: NULL if either side is NULL."
  [pred a b]
  (if (or (nil? a) (nil? b)) nil (pred (compare-values a b))))

(defn eq [a b] (cmp zero? a b))
(defn ne [a b] (cmp (complement zero?) a b))
(defn lt [a b] (cmp neg? a b))
(defn le [a b] (cmp (complement pos?) a b))
(defn gt [a b] (cmp pos? a b))
(defn ge [a b] (cmp (complement neg?) a b))

;;; --------------------------------------------- three-valued logic -------------------------------------------

(defn and3
  "SQL AND: false wins over NULL, NULL wins over true."
  [a b]
  (cond (or (false? a) (false? b)) false
        (or (nil? a) (nil? b))     nil
        :else                      true))

(defn or3
  "SQL OR: true wins over NULL, NULL wins over false."
  [a b]
  (cond (or (true? a) (true? b)) true
        (or (nil? a) (nil? b))   nil
        :else                    false))

(defn not3 [a] (if (nil? a) nil (not a)))

(defn truthy?
  "A predicate keeps a row only if it is exactly true; NULL behaves like false."
  [v]
  (true? v))

;;; ------------------------------------------------ functions -------------------------------------------------

(def functions
  "Scalar functions by (lower-case) name. NULL in, NULL out, except coalesce."
  {"lower"    (fn [s] (some-> s str .toLowerCase))
   "upper"    (fn [s] (some-> s str .toUpperCase))
   "length"   (fn [s] (some-> s str count long))
   "abs"      (fn [x] (when (some? x) (if (int? x) (Math/abs (long x)) (Math/abs (double x)))))
   "coalesce" (fn [& xs] (first (remove nil? xs)))})

(defn call-function [name args]
  (if-let [f (functions name)]
    (apply f args)
    (throw (ex-info (str "unknown function " name) {:name name}))))

(def binary-ops
  "Binary operator keyword → implementation. Shared by the closure compiler and the VM."
  {:+ add, :- sub, :* mul, :/ div
   := eq, :!= ne, :< lt, :<= le, :> gt, :>= ge
   :and and3, :or or3})

;;; ---------------------------------------------- hashing & sorting -------------------------------------------

(defn hash-key
  "Normalize a value for use as a hash-table key: 2 and 2.0 must land in the same bucket, the way
  `=` in SQL treats them. (Clojure's `=` says (= 2 2.0) is false.)"
  [v]
  (if (and (double? v) (not (Double/isInfinite v)) (== v (Math/rint v)))
    (long v)
    v))

(defn sort-compare
  "Compare two values for ORDER BY: NULLs sort last whether ascending or descending."
  [desc? a b]
  (cond
    (and (nil? a) (nil? b)) 0
    (nil? a)                1
    (nil? b)                -1
    desc?                   (compare-values b a)
    :else                   (compare-values a b)))

(defn row-comparator
  "A comparator over rows, given [[index desc?] …] sort keys."
  [keys]
  (fn [ra rb]
    (loop [[[i desc?] & more] keys]
      (if (nil? i)
        0
        (let [c (sort-compare desc? (nth ra i) (nth rb i))]
          (if (zero? c) (recur more) c))))))

;;; ------------------------------------------------ formatting ------------------------------------------------

(defn format-value
  "Canonical text for a value: NULL, ints in decimal, floats with exactly 2 decimals.
  Floats round the exact binary value half-to-even, which is what Go's %.2f does — Java's own
  String/format rounds the shortest decimal representation half-up and disagrees on cases like 1.005."
  [v]
  (cond
    (nil? v)    "NULL"
    (double? v) (-> (BigDecimal. (double v)) (.setScale 2 RoundingMode/HALF_EVEN) .toPlainString)
    :else       (str v)))
