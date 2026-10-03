(ns engine.vm
  "A register-based bytecode VM, modeled on SQLite's VDBE.

  The machine's entire state is one immutable map:

    {:pc       12                          ; next instruction
     :regs     [nil 7 \"Ada\" …]            ; registers
     :cursors  {0 {:table \"orders\" :pos 41}       ; table / index cursors
                1 {:table \"customers\" :rowids [6] :pos 0}}
     :hash     {0 {:buckets {7 [[…] …]} :probe {:key 7 :pos 0}}}
     :sorters  {0 {:spec [[0 true]] :rows […] :pos 3}}
     :aggs     {0 {:fns [\"count*\"] :n-keys 1 :table … :rows … :pos 0}}
     :halted?  false}

  Nothing in it points at the Java stack or at a live iterator; cursors are just positions into the
  (immutable) tables. So `step` can stop after any instruction — when a row is produced, or when it
  runs out of fuel — and the state can be printed as EDN, read back later (in another process even),
  and resumed exactly where it left off. That is the whole point of part 7."
  (:require [clojure.edn :as edn]
            [clojure.string :as str]
            [engine.agg :as agg]
            [engine.btree :as btree]
            [engine.value :as v]))

(defn initial-state
  "A fresh machine for a program: pc 0, every register NULL."
  [program]
  {:pc 0 :regs (vec (repeat (:registers program) nil))
   :cursors {} :hash {} :sorters {} :aggs {} :halted? false})

;;; ------------------------------------------------- cursors --------------------------------------------------

(defn- cursor-row
  "The row a table or index cursor is positioned on."
  [catalog {:keys [table rowids pos]}]
  (let [rows (get-in catalog [:tables table :rows])]
    (rows (if rowids (rowids pos) pos))))

;;; ------------------------------------------------ execution -------------------------------------------------

(def ^:private binary-op
  {:Add v/add :Sub v/sub :Mul v/mul :Div v/div
   :Eq v/eq :Ne v/ne :Lt v/lt :Le v/le :Gt v/gt :Ge v/ge
   :And v/and3 :Or v/or3})

(defn- reg [state r] (nth (:regs state) r))
(defn- set-reg [state r x] (assoc-in state [:regs r] x))
(defn- regs-slice [state first n] (subvec (:regs state) first (+ first n)))
(defn- goto [state addr] (assoc state :pc addr))
(defn- advance [state] (update state :pc inc))

(defn- exec
  "Execute one instruction: state → state. ResultRow is handled by the caller."
  [catalog state {:keys [op p1 p2 p3 p4]}]
  (case op
    :Init  (goto state p2)
    :Goto  (goto state p2)
    :Halt  (assoc state :halted? true)

    ;; --- table and index cursors
    :OpenScan (advance (assoc-in state [:cursors p1] {:table p4 :pos 0}))
    :Rewind   (let [n (count (get-in catalog [:tables (get-in state [:cursors p1 :table]) :rows]))]
                (if (zero? n) (goto state p2) (advance (assoc-in state [:cursors p1 :pos] 0))))
    :Next     (let [c    (get-in state [:cursors p1])
                    n    (count (get-in catalog [:tables (:table c) :rows]))
                    pos' (inc (:pos c))]
                (if (< pos' n)
                  (goto (assoc-in state [:cursors p1 :pos] pos') p2)
                  (advance (assoc-in state [:cursors p1 :pos] pos'))))
    :Column   (advance (set-reg state p3 (nth (cursor-row catalog (get-in state [:cursors p1])) p2)))
    :SeekIndex  (let [[table _] (str/split p4 #"\.")
                      rowids    (btree/lookup (get-in catalog [:indexes p4]) (reg state p2))
                      state     (assoc-in state [:cursors p1] {:table table :rowids rowids :pos 0})]
                  (if (empty? rowids) (goto state p3) (advance state)))
    :IndexRange (let [{:keys [index lo hi]} p4
                      [table _] (str/split index #"\.")
                      rowids    (btree/range-rowids (get-in catalog [:indexes index]) lo hi)
                      state     (assoc-in state [:cursors p1] {:table table :rowids rowids :pos 0})]
                  (if (empty? rowids) (goto state p3) (advance state)))
    :IndexNext  (let [c (get-in state [:cursors p1]) pos' (inc (:pos c))]
                  (if (< pos' (count (:rowids c)))
                    (goto (assoc-in state [:cursors p1 :pos] pos') p2)
                    (advance state)))

    ;; --- registers and expressions
    (:Integer :Const) (advance (set-reg state p2 p4))
    :Copy     (advance (set-reg state p2 (reg state p1)))
    (:Add :Sub :Mul :Div :Eq :Ne :Lt :Le :Gt :Ge :And :Or)
    (advance (set-reg state p3 ((binary-op op) (reg state p1) (reg state p2))))
    :Not      (advance (set-reg state p3 (v/not3 (reg state p1))))
    :IsNull   (advance (set-reg state p3 (nil? (reg state p1))))
    :NotNull  (advance (set-reg state p3 (some? (reg state p1))))
    :Func     (advance (set-reg state p3 (v/call-function p4 (regs-slice state p1 p2))))

    ;; --- control flow
    :IfNot        (if (v/truthy? (reg state p1)) (advance state) (goto state p2))
    :If           (if (v/truthy? (reg state p1)) (goto state p2) (advance state))
    :DecrJumpZero (let [n (dec (reg state p1)) state (set-reg state p1 n)]
                    (if (zero? n) (goto state p2) (advance state)))

    ;; --- hash tables (hash join build + probe)
    :HashOpen   (advance (assoc-in state [:hash p1] {:buckets {} :probe nil}))
    :HashInsert (let [k (reg state p2)]
                  (advance (if (nil? k)
                             state
                             (update-in state [:hash p1 :buckets (v/hash-key k)] (fnil conj []) (regs-slice state p3 p4)))))
    :HashSeek   (let [k (reg state p2)
                      matches (when (some? k) (get-in state [:hash p1 :buckets (v/hash-key k)]))]
                  (if (empty? matches)
                    (goto state p3)
                    (advance (assoc-in state [:hash p1 :probe] {:key (v/hash-key k) :pos 0}))))
    :HashNext   (let [{:keys [key pos]} (get-in state [:hash p1 :probe])
                      n (count (get-in state [:hash p1 :buckets key]))]
                  (if (< (inc pos) n)
                    (goto (assoc-in state [:hash p1 :probe :pos] (inc pos)) p2)
                    (advance state)))
    :HashColumn (let [{:keys [key pos]} (get-in state [:hash p1 :probe])]
                  (advance (set-reg state p3 (get-in state [:hash p1 :buckets key pos p2]))))

    ;; --- sorters (ORDER BY)
    :SorterOpen   (advance (assoc-in state [:sorters p1] {:spec p4 :rows [] :pos 0}))
    :SorterInsert (advance (update-in state [:sorters p1 :rows] conj (regs-slice state p2 p3)))
    :SorterSort   (let [{:keys [spec rows]} (get-in state [:sorters p1])
                        sorted (vec (sort (v/row-comparator spec) rows))   ; java sort: stable
                        state  (update-in state [:sorters p1] assoc :rows sorted :pos 0)]
                    (if (empty? sorted) (goto state p2) (advance state)))
    :SorterNext   (let [{:keys [rows pos]} (get-in state [:sorters p1])]
                    (if (< (inc pos) (count rows))
                      (goto (assoc-in state [:sorters p1 :pos] (inc pos)) p2)
                      (advance state)))
    :SorterColumn (let [{:keys [rows pos]} (get-in state [:sorters p1])]
                    (advance (set-reg state p3 (nth (rows pos) p2))))

    ;; --- aggregation (GROUP BY)
    :AggOpen   (advance (assoc-in state [:aggs p1] (assoc p4 :table agg/empty-table :rows nil :pos 0)))
    :AggStep   (let [{:keys [fns]} (get-in state [:aggs p1])]
                 (advance (update-in state [:aggs p1 :table] agg/add-row fns
                                     (regs-slice state p2 p3) (regs-slice state p4 (count fns)))))
    :AggRewind (let [{:keys [fns n-keys table]} (get-in state [:aggs p1])
                     rows  (agg/result-rows table fns n-keys)
                     state (update-in state [:aggs p1] assoc :rows rows :pos 0 :table nil)]
                 (if (empty? rows) (goto state p2) (advance state)))
    :AggNext   (let [{:keys [rows pos]} (get-in state [:aggs p1])]
                 (if (< (inc pos) (count rows))
                   (goto (assoc-in state [:aggs p1 :pos] (inc pos)) p2)
                   (advance state)))
    :AggColumn (let [{:keys [rows pos]} (get-in state [:aggs p1])]
                 (advance (set-reg state p3 (nth (rows pos) p2))))

    (throw (ex-info (str "unknown opcode " op) {:op op}))))

(defn step
  "Run until the program produces a row, halts, or has executed `fuel` instructions (nil = no limit).
  Returns {:status :row|:done|:out-of-fuel, :row [...] (for :row), :state state'}."
  [program catalog state fuel]
  (let [code (:code program)]
    (loop [state state fuel fuel]
      (cond
        (:halted? state)               {:status :done :state state}
        (and fuel (<= fuel 0))         {:status :out-of-fuel :state state}
        :else
        (let [{:keys [op p1 p2] :as ins} (code (:pc state))]
          (if (= op :ResultRow)
            {:status :row :row (regs-slice state p1 p2) :state (advance state)}
            (recur (exec catalog state ins) (some-> fuel dec))))))))

(defn run
  "Run a program to completion, returning all rows."
  [program catalog]
  (loop [state (initial-state program) rows []]
    (let [{:keys [status row state]} (step program catalog state nil)]
      (if (= status :row) (recur state (conj rows row)) rows))))

;;; ---------------------------------------------- snapshot/restore ---------------------------------------------

(defn snapshot
  "The machine state as an EDN string. Program and data are not included: like a SQLite statement,
  the state only makes sense next to the program and database it was running against."
  [state]
  (binding [*print-length* nil *print-level* nil *print-namespace-maps* false]
    (pr-str state)))

(defn restore
  "Read a snapshot back into a state that `step` can continue."
  [s]
  (edn/read-string s))

;;; -------------------------------------------------- listing -------------------------------------------------

(defn- show [x]
  (cond (nil? x) "" (string? x) x (map? x) (pr-str x) (vector? x) (pr-str x) :else (str x)))

(defn listing
  "The program in SQLite EXPLAIN layout: addr opcode p1 p2 p3 p4 comment."
  [program]
  (str/join "\n"
            (cons (format "%-4s  %-13s %4s %4s %4s  %-24s %s" "addr" "opcode" "p1" "p2" "p3" "p4" "comment")
                  (map-indexed
                   (fn [addr {:keys [op p1 p2 p3 p4 comment]}]
                     (let [p4s (show p4)]
                       (format "%-4d  %-13s %4s %4s %4s  %-24s %s"
                               addr (name op) (show p1) (show p2) (show p3)
                               (if (> (count p4s) 24) (str (subs p4s 0 21) "...") p4s)
                               (or comment ""))))
                   (:code program)))))
