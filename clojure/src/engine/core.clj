(ns engine.core
  "The whole pipeline, end to end:

    SQL text ─parse→ statement ─plan→ physical plan ─┬─ volcano/run  → rows
                                                      └─ compile → vm/run → rows

  Both executors run the same plan and must produce the same rows."
  (:require [clojure.string :as str]
            [engine.compiler :as compiler]
            [engine.planner :as planner]
            [engine.sql :as sql]
            [engine.value :as v]
            [engine.vm :as vm]
            [engine.volcano :as volcano]))

(defn prepare
  "SQL → {:stmt :plan :columns}."
  [catalog sql-text]
  (let [stmt (sql/parse sql-text)]
    (assoc (planner/plan catalog stmt) :stmt stmt)))

(defn execute
  "Run SQL. Options: :executor (:volcano or :vm). Returns {:columns :rows :plan :program?}.
  For EXPLAIN, :rows is nil and :explain holds the plan text."
  [catalog sql-text {:keys [executor] :or {executor :volcano}}]
  (let [{:keys [stmt plan columns]} (prepare catalog sql-text)]
    (if (:explain? stmt)
      {:columns columns :plan plan :explain (planner/explain plan)}
      (if (= executor :vm)
        (let [program (compiler/compile-plan plan)]
          {:columns columns :plan plan :program program :rows (vm/run program catalog)})
        {:columns columns :plan plan :rows (volcano/run catalog plan)}))))

(defn canonical
  "The canonical result text from DESIGN.md: header, rows, `(N rows)`."
  [{:keys [columns rows]}]
  (str/join "\n"
            (concat [(str/join " | " columns)]
                    (map #(str/join " | " (map v/format-value %)) rows)
                    [(str "(" (count rows) " rows)")])))

(defn golden-queries
  "The queries in a golden file: one per line, skipping blanks and `--` comments."
  [text]
  (->> (str/split-lines text)
       (map str/trim)
       (remove #(or (str/blank? %) (str/starts-with? % "--")))))

(defn golden-report
  "Every golden query followed by its canonical output, blank line between."
  [catalog text opts]
  (str/join "\n\n"
            (for [q (golden-queries text)]
              (str q "\n" (canonical (execute catalog q opts))))))
