(ns engine.sql
  "Tokenizer and recursive-descent parser for the SQL subset in DESIGN.md.

  The parser knows nothing about tables: it turns text into an AST of plain data and leaves name
  resolution to the planner. Expressions use the shared hiccup-style shape:

    [:col \"c.name\"]  [:lit 3]  [:+ a b]  [:and a b]  [:not e]  [:is-null e]  [:is-not-null e]
    [:fn \"lower\" e]  [:agg \"sum\" e]  [:agg \"count\" :*]

  A statement:

    {:explain? false
     :select   [{:expr e :alias \"n\"} …] | :star
     :from     [{:table \"customers\" :alias \"c\"} …]     ; comma joins and JOINs alike
     :join-on  [e …]                                       ; ON conditions, ANDed into WHERE later
     :where e  :group-by [e …]  :having e
     :order-by [{:expr e :desc? bool} …]  :limit n}"
  (:require [clojure.string :as str]))

;;; ------------------------------------------------- tokenizer ------------------------------------------------

(def keywords
  #{"select" "from" "where" "group" "by" "having" "order" "asc" "desc" "limit" "join" "inner"
    "on" "as" "and" "or" "not" "is" "null" "true" "false" "explain"})

(def aggregate-functions #{"count" "sum" "min" "max" "avg"})

(defn tokenize
  "Text → [{:type :ident|:keyword|:number|:string|:op :value …}]. Identifiers and keywords are
  case-insensitive (lower-cased); string literals keep their case."
  [^String s]
  (loop [i 0 out []]
    (if (>= i (count s))
      (conj out {:type :eof})
      (let [c (.charAt s i)]
        (cond
          (Character/isWhitespace c) (recur (inc i) out)

          (or (Character/isLetter c) (= c \_))
          (let [j    (loop [j i] (if (and (< j (count s))
                                          (let [d (.charAt s j)] (or (Character/isLetterOrDigit d) (= d \_))))
                                   (recur (inc j)) j))
                word (str/lower-case (subs s i j))]
            (recur j (conj out {:type (if (keywords word) :keyword :ident) :value word})))

          (Character/isDigit c)
          (let [j    (loop [j i] (if (and (< j (count s))
                                          (let [d (.charAt s j)] (or (Character/isDigit d) (= d \.))))
                                   (recur (inc j)) j))
                text (subs s i j)]
            (recur j (conj out {:type :number
                                :value (if (str/includes? text ".") (Double/parseDouble text) (Long/parseLong text))})))

          (= c \')
          (let [sb (StringBuilder.)
                j  (loop [j (inc i)]
                     (cond
                       (>= j (count s)) (throw (ex-info "unterminated string literal" {:at i}))
                       (and (= (.charAt s j) \') (< (inc j) (count s)) (= (.charAt s (inc j)) \'))
                       (do (.append sb \') (recur (+ j 2)))
                       (= (.charAt s j) \') (inc j)
                       :else (do (.append sb (.charAt s j)) (recur (inc j)))))]
            (recur j (conj out {:type :string :value (str sb)})))

          :else
          (let [two (when (< (inc i) (count s)) (subs s i (+ i 2)))]
            (cond
              (#{"<=" ">=" "!=" "<>"} two) (recur (+ i 2) (conj out {:type :op :value (if (= two "<>") "!=" two)}))
              (#{\= \< \> \+ \- \* \/ \( \) \, \. \;} c) (recur (inc i) (conj out {:type :op :value (str c)}))
              :else (throw (ex-info (str "unexpected character '" c "'") {:at i})))))))))

;;; -------------------------------------------------- parser --------------------------------------------------

(defn- parser [tokens] {:tokens tokens :pos (volatile! 0)})

(defn- peek-tok [{:keys [tokens pos]}] (nth tokens @pos))
(defn- advance! [{:keys [pos] :as p}] (let [t (peek-tok p)] (vswap! pos inc) t))

(defn- is? [p type value]
  (let [t (peek-tok p)] (and (= type (:type t)) (or (nil? value) (= value (:value t))))))

(defn- accept! [p type value] (when (is? p type value) (advance! p)))

(defn- expect! [p type value]
  (or (accept! p type value)
      (let [t (peek-tok p)]
        (throw (ex-info (str "expected " (or value (name type)) " but found "
                             (if (= :eof (:type t)) "end of input" (pr-str (:value t))))
                        {:token t})))))

(declare parse-expr)

(defn- parse-primary [p]
  (let [t (peek-tok p)]
    (cond
      (= :number (:type t)) (do (advance! p) [:lit (:value t)])
      (= :string (:type t)) (do (advance! p) [:lit (:value t)])
      (accept! p :keyword "null")  [:lit nil]
      (accept! p :keyword "true")  [:lit true]
      (accept! p :keyword "false") [:lit false]
      (accept! p :op "(") (let [e (parse-expr p)] (expect! p :op ")") e)

      (= :ident (:type t))
      (let [name (:value (advance! p))]
        (cond
          (accept! p :op "(")
          (if (aggregate-functions name)
            (let [arg (if (accept! p :op "*") :* (parse-expr p))]
              (expect! p :op ")")
              [:agg name arg])
            (let [args (if (is? p :op ")") [] (loop [args [(parse-expr p)]]
                                                 (if (accept! p :op ",") (recur (conj args (parse-expr p))) args)))]
              (expect! p :op ")")
              (into [:fn name] args)))

          (accept! p :op ".") [:col (str name "." (:value (expect! p :ident nil)))]
          :else [:col name]))

      :else (throw (ex-info (str "unexpected " (if (= :eof (:type t)) "end of input" (pr-str (:value t))))
                            {:token t})))))

(defn- parse-unary [p]
  (if (accept! p :op "-")
    (let [e (parse-unary p)]
      (if (and (= :lit (first e)) (number? (second e))) [:lit (- (second e))] [:- [:lit 0] e]))
    (parse-primary p)))

(defn- parse-binary-level
  "One precedence level: operand (op operand)*, left-associative."
  [p next-level ops]
  (loop [left (next-level p)]
    (let [t (peek-tok p)]
      (if (and (= :op (:type t)) (ops (:value t)))
        (do (advance! p) (recur [(keyword (:value t)) left (next-level p)]))
        left))))

(defn- parse-mul [p] (parse-binary-level p parse-unary #{"*" "/"}))
(defn- parse-add [p] (parse-binary-level p parse-mul #{"+" "-"}))

(defn- parse-comparison [p]
  (let [left (parse-add p)]
    (cond
      (accept! p :keyword "is")
      (let [negate? (accept! p :keyword "not")]
        (expect! p :keyword "null")
        [(if negate? :is-not-null :is-null) left])

      (and (= :op (:type (peek-tok p))) (#{"=" "!=" "<" "<=" ">" ">="} (:value (peek-tok p))))
      [(keyword (:value (advance! p))) left (parse-add p)]

      :else left)))

(defn- parse-not [p]
  (if (accept! p :keyword "not") [:not (parse-not p)] (parse-comparison p)))

(defn- parse-and [p]
  (loop [left (parse-not p)]
    (if (accept! p :keyword "and") (recur [:and left (parse-not p)]) left)))

(defn parse-expr [p]
  (loop [left (parse-and p)]
    (if (accept! p :keyword "or") (recur [:or left (parse-and p)]) left)))

(defn- parse-list [p parse-item]
  (loop [items [(parse-item p)]]
    (if (accept! p :op ",") (recur (conj items (parse-item p))) items)))

(defn- parse-select-item [p]
  (let [e     (parse-expr p)
        alias (cond (accept! p :keyword "as") (:value (expect! p :ident nil))
                    (is? p :ident nil)        (:value (advance! p)))]
    (cond-> {:expr e} alias (assoc :alias alias))))

(defn- parse-table-ref [p]
  (let [table (:value (expect! p :ident nil))
        alias (cond (accept! p :keyword "as") (:value (expect! p :ident nil))
                    (is? p :ident nil)        (:value (advance! p))
                    :else                     table)]
    {:table table :alias alias}))

(defn- parse-order-item [p]
  (let [e (parse-expr p)]
    {:expr e :desc? (boolean (and (not (accept! p :keyword "asc")) (accept! p :keyword "desc")))}))

(defn- parse-from [p]
  (loop [from [(parse-table-ref p)] on []]
    (cond
      (accept! p :op ",") (recur (conj from (parse-table-ref p)) on)
      (or (is? p :keyword "join") (is? p :keyword "inner"))
      (do (accept! p :keyword "inner")
          (expect! p :keyword "join")
          (let [t (parse-table-ref p)]
            (expect! p :keyword "on")
            (recur (conj from t) (conj on (parse-expr p)))))
      :else [from on])))

(defn parse
  "SQL text → statement map (see ns docstring)."
  [sql]
  (let [p        (parser (tokenize sql))
        explain? (boolean (accept! p :keyword "explain"))
        _        (expect! p :keyword "select")
        select   (if (accept! p :op "*") :star (parse-list p parse-select-item))
        _        (expect! p :keyword "from")
        [from on] (parse-from p)
        where    (when (accept! p :keyword "where") (parse-expr p))
        group-by (when (accept! p :keyword "group") (expect! p :keyword "by") (parse-list p parse-expr))
        having   (when (accept! p :keyword "having") (parse-expr p))
        order-by (when (accept! p :keyword "order") (expect! p :keyword "by") (parse-list p parse-order-item))
        limit    (when (accept! p :keyword "limit") (:value (expect! p :number nil)))]
    (accept! p :op ";")
    (expect! p :eof nil)
    {:explain? explain? :select select :from from :join-on on :where where
     :group-by (or group-by []) :having having :order-by (or order-by []) :limit limit}))

;;; ------------------------------------------------- rendering ------------------------------------------------

(defn render
  "Expression → SQL-ish text. Used for output column headers when there is no alias:
  a column renders as written (`c.name`), calls as `name(args)`, `count(*)` for COUNT(*)."
  [e]
  (case (first e)
    :col (second e)
    :lit (let [x (second e)] (cond (nil? x) "NULL" (string? x) (str "'" x "'") :else (str x)))
    :fn  (str (second e) "(" (str/join ", " (map render (nnext e))) ")")
    :agg (str (second e) "(" (if (= :* (nth e 2)) "*" (render (nth e 2))) ")")
    :not (str "NOT " (render (second e)))
    :is-null (str (render (second e)) " IS NULL")
    :is-not-null (str (render (second e)) " IS NOT NULL")
    (str (render (nth e 1)) " " (str/upper-case (name (first e))) " " (render (nth e 2)))))
