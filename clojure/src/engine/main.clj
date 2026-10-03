(ns engine.main
  "Command line and REPL.

    clojure -M -m engine.main                       REPL
    clojure -M -m engine.main -e \"SELECT …\"         run one query
    clojure -M -m engine.main --vm -e \"…\"           … on the bytecode VM
    clojure -M -m engine.main --golden ../queries/golden.sql

  REPL meta-commands: \\vm (toggle executor), \\explain on|off, \\program (show bytecode for the
  next query), \\stats <table>, \\q."
  (:require [clojure.string :as str]
            [engine.core :as core]
            [engine.data :as data]
            [engine.planner :as planner]
            [engine.value :as v]
            [engine.vm :as vm])
  (:gen-class))

(defn- print-stats [catalog table]
  (if-let [{:keys [rows columns]} (get-in catalog [:stats table])]
    (do (println (str table ": " rows " rows"))
        (doseq [[col {:keys [nulls ndv min max histogram]}] (sort-by key columns)]
          (println (format "  %-12s nulls=%-4d ndv=%-5d min=%-10s max=%-10s" col nulls ndv (v/format-value min) (v/format-value max)))
          (println (str "  " (apply str (repeat 12 " ")) " histogram: "
                        (str/join "  " (map #(str "≤" (v/format-value (:hi %)) ":" (:count %)) histogram))))))
    (println "no such table:" table)))

(defn- run-and-print [catalog sql {:keys [vm? explain? program?]}]
  (try
    (let [result (core/execute catalog sql {:executor (if vm? :vm :volcano)})]
      (cond
        (:explain result) (println (:explain result))
        :else
        (do (when explain? (println (planner/explain (:plan result))) (println))
            (when (and program? (:program result)) (println (vm/listing (:program result))) (println))
            (println (core/canonical result)))))
    (catch clojure.lang.ExceptionInfo e
      (println "error:" (ex-message e)))))

(defn repl [catalog]
  (println "execution engine — type SQL, or \\vm \\explain on|off \\program \\stats <table> \\q")
  (loop [opts {:vm? false :explain? false :program? false}]
    (print (if (:vm? opts) "ee(vm)> " "ee> "))
    (flush)
    (when-let [line (read-line)]
      (let [line (str/trim line)]
        (cond
          (str/blank? line)            (recur opts)
          (= line "\\q")               nil
          (= line "\\vm")              (do (println "executor:" (if (:vm? opts) "volcano" "vm"))
                                           (recur (update opts :vm? not)))
          (= line "\\explain on")      (recur (assoc opts :explain? true))
          (= line "\\explain off")     (recur (assoc opts :explain? false))
          (= line "\\program")         (do (println "bytecode will be shown for the next query (runs on the VM)")
                                           (recur (assoc opts :program? true)))
          (str/starts-with? line "\\stats") (do (print-stats catalog (str/trim (subs line 6))) (recur opts))
          :else (do (run-and-print catalog line (cond-> opts (:program? opts) (assoc :vm? true)))
                    (recur (assoc opts :program? false))))))))

(defn -main [& args]
  (let [catalog (data/catalog)
        args    (vec args)
        flag?   #(some #{%} args)
        value   (fn [f] (some-> (.indexOf ^java.util.List args f) (as-> i (when (>= i 0) (get args (inc i))))))
        vm?     (boolean (or (flag? "--vm") (flag? "-vm")))]
    (cond
      (value "--golden") (println (core/golden-report catalog (slurp (value "--golden"))
                                                     {:executor (if vm? :vm :volcano)}))
      (value "-e")       (run-and-print catalog (value "-e") {:vm? vm? :program? (boolean (flag? "--program"))})
      :else              (repl catalog))
    (shutdown-agents)))
