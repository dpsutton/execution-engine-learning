(ns engine.compiler
  "Physical plan → bytecode, by produce/consume (Neumann 2011; SQLite emits the same shape).

  `(produce ctx node consume)` emits the code that generates node's rows. For each row it calls
  `consume` with the registers holding that row's columns, and `consume` emits whatever the parent
  does with one row — so a whole pipeline (scan → filter → join probe → project → output) becomes one
  loop body with no per-operator calls at run time.

  Pipeline breakers end one loop and start another: a hash join's build side is produced into a
  HashInsert, then the probe side's loop does HashSeek/HashNext; a sort fills a sorter, then loops
  over it; an aggregate folds every row into AggStep, then loops over the groups.

  Jumps to code not yet emitted are emitted with a placeholder and patched once the target is known."
  (:require [clojure.string :as str]
            [engine.agg :as agg]
            [engine.sql :as sql]))

;;; ---------------------------------------------- emission helpers --------------------------------------------

(defn- new-ctx []
  (volatile! {:code [] :registers 0 :cursors 0 :hash 0 :sorters 0 :aggs 0 :exits []}))

(defn- here [ctx] (count (:code @ctx)))

(defn- emit!
  "Append an instruction; returns its address."
  [ctx op & {:as params}]
  (let [addr (here ctx)]
    (vswap! ctx update :code conj (merge {:op op :p1 nil :p2 nil :p3 nil :p4 nil :comment nil} params))
    addr))

(defn- patch!
  "Point param `p` of the instruction at `addr` to the current address."
  [ctx addr p]
  (vswap! ctx assoc-in [:code addr p] (here ctx)))

(defn- exit!
  "Remember a jump at `addr` whose p2 must point at the final Halt (patched in compile-plan).
  (Takes the address as a value: `(vswap! ctx … (emit! ctx …))` would deref ctx before emit! ran
  and silently drop the emitted instruction.)"
  [ctx addr]
  (vswap! ctx update :exits conj addr))

(defn- alloc!
  "Reserve n consecutive slots of a kind (:registers :cursors :hash :sorters :aggs); returns the first."
  ([ctx kind] (alloc! ctx kind 1))
  ([ctx kind n]
   (let [first (get @ctx kind)]
     (vswap! ctx update kind + n)
     first)))

(defn- contiguous!
  "Instructions like ResultRow and SorterInsert read n consecutive registers. If `regs` aren't already
  consecutive, copy them into a fresh block. Returns the first register."
  [ctx regs]
  (if (and (seq regs) (= regs (vec (range (first regs) (+ (first regs) (count regs))))))
    (first regs)
    (let [base (alloc! ctx :registers (count regs))]
      (doseq [[i r] (map-indexed vector regs)]
        (emit! ctx :Copy :p1 r :p2 (+ base i)))
      base)))

;;; ------------------------------------------------ expressions -----------------------------------------------

(def ^:private opcodes
  {:+ :Add :- :Sub :* :Mul :/ :Div := :Eq :!= :Ne :< :Lt :<= :Le :> :Gt :>= :Ge :and :And :or :Or})

(defn- expr!
  "Emit code evaluating e; returns the register that will hold the result.
  `env` maps column name → register. A column reference emits nothing at all."
  [ctx env e]
  (case (first e)
    :col (or (env (second e)) (throw (ex-info (str "no register for " (second e)) {:env env})))
    :lit (let [r (alloc! ctx :registers) x (second e)]
           (emit! ctx (if (int? x) :Integer :Const) :p2 r :p4 x)
           r)
    (:not :is-null :is-not-null)
    (let [a (expr! ctx env (second e)) r (alloc! ctx :registers)]
      (emit! ctx ({:not :Not :is-null :IsNull :is-not-null :NotNull} (first e)) :p1 a :p3 r)
      r)
    :fn  (let [args (mapv #(expr! ctx env %) (nnext e))
               base (if (seq args) (contiguous! ctx args) 0)
               r    (alloc! ctx :registers)]
           (emit! ctx :Func :p1 base :p2 (count args) :p3 r :p4 (second e))
           r)
    (let [a (expr! ctx env (nth e 1))
          b (expr! ctx env (nth e 2))
          r (alloc! ctx :registers)]
      (emit! ctx (opcodes (first e)) :p1 a :p2 b :p3 r :comment (str "r" r " = " (sql/render e)))
      r)))

(defn- column-loads!
  "Emit `load-one` for every column into fresh registers; returns them."
  [ctx schema load-one]
  (let [base (alloc! ctx :registers (count schema))]
    (doseq [[i col] (map-indexed vector schema)]
      (load-one i (+ base i) col))
    (vec (range base (+ base (count schema))))))

;;; ------------------------------------------------- operators ------------------------------------------------

(defmulti produce
  "Emit code producing node's rows; calls (consume regs) to emit the per-row continuation."
  (fn [_ctx node _consume] (:op node)))

(defn- table-loop!
  "The standard cursor loop shared by full and index scans."
  [ctx cursor schema consume open-and-position! next-op]
  (let [miss  (open-and-position!)
        top   (here ctx)
        regs  (column-loads! ctx schema
                             (fn [i r col] (emit! ctx :Column :p1 cursor :p2 i :p3 r :comment (str "r" r " = " col))))]
    (consume regs)
    (emit! ctx next-op :p1 cursor :p2 top)
    (patch! ctx miss (if (= next-op :Next) :p2 :p3))))

(defmethod produce :scan [ctx {:keys [table schema]} consume]
  (let [c (alloc! ctx :cursors)]
    (table-loop! ctx c schema consume
                 #(do (emit! ctx :OpenScan :p1 c :p4 table :comment (str "cursor " c " on " table))
                      (emit! ctx :Rewind :p1 c :comment "empty table → skip loop"))
                 :Next)))

(defmethod produce :index-scan [ctx {:keys [table column lo hi schema]} consume]
  (let [c (alloc! ctx :cursors)]
    (table-loop! ctx c schema consume
                 #(emit! ctx :IndexRange :p1 c :p4 {:index (str table "." column) :lo lo :hi hi}
                         :comment (str "cursor " c " on " table "." column " range"))
                 :IndexNext)))

(defmethod produce :filter [ctx {:keys [input pred]} consume]
  (produce ctx input
           (fn [regs]
             (let [r    (expr! ctx (zipmap (:schema input) regs) pred)
                   skip (emit! ctx :IfNot :p1 r :comment (str "WHERE " (sql/render pred)))]
               (consume regs)
               (patch! ctx skip :p2)))))

(defmethod produce :project [ctx {:keys [input exprs]} consume]
  (produce ctx input
           (fn [regs]
             (let [env (zipmap (:schema input) regs)]
               (consume (mapv #(expr! ctx env %) exprs))))))

(defmethod produce :limit [ctx {:keys [input n]} consume]
  (let [counter (alloc! ctx :registers)]
    (emit! ctx :Integer :p2 counter :p4 n :comment (str "LIMIT " n))
    (when (<= n 0)
      (exit! ctx (emit! ctx :Goto :comment "LIMIT 0")))
    (produce ctx input
             (fn [regs]
               (consume regs)
               ;; after emitting a row: one fewer to go; at zero, jump straight to Halt
               (exit! ctx (emit! ctx :DecrJumpZero :p1 counter :comment "limit reached → Halt"))))))

(defmethod produce :nl-join [ctx {:keys [left right pred]} consume]
  (produce ctx left
           (fn [lregs]
             ;; the whole inner plan is emitted inside the outer loop, so it re-runs per outer row
             (produce ctx right
                      (fn [rregs]
                        (let [regs (into lregs rregs)]
                          (if pred
                            (let [r    (expr! ctx (zipmap (into (:schema left) (:schema right)) regs) pred)
                                  skip (emit! ctx :IfNot :p1 r :comment "join condition")]
                              (consume regs)
                              (patch! ctx skip :p2))
                            (consume regs))))))))

(defmethod produce :hash-join [ctx {:keys [left right left-key right-key]} consume]
  (let [h (alloc! ctx :hash)
        n (count (:schema right))]
    (emit! ctx :HashOpen :p1 h :comment "build side ↓")
    (produce ctx right
             (fn [rregs]
               (let [k (expr! ctx (zipmap (:schema right) rregs) right-key)]
                 (emit! ctx :HashInsert :p1 h :p2 k :p3 (contiguous! ctx rregs) :p4 n
                        :comment (str "key " (sql/render right-key))))))
    (produce ctx left
             (fn [lregs]
               (let [k    (expr! ctx (zipmap (:schema left) lregs) left-key)
                     miss (emit! ctx :HashSeek :p1 h :p2 k :comment (str "probe with " (sql/render left-key)))
                     top  (here ctx)
                     rregs (column-loads! ctx (:schema right)
                                          (fn [i r col] (emit! ctx :HashColumn :p1 h :p2 i :p3 r :comment (str "r" r " = " col))))]
                 (consume (into lregs rregs))
                 (emit! ctx :HashNext :p1 h :p2 top)
                 (patch! ctx miss :p3))))))

(defmethod produce :index-nl-join [ctx {:keys [left table column key inner-filter right-schema]} consume]
  (let [c (alloc! ctx :cursors)]
    (produce ctx left
             (fn [lregs]
               (let [k     (expr! ctx (zipmap (:schema left) lregs) key)
                     miss  (emit! ctx :SeekIndex :p1 c :p2 k :p4 (str table "." column)
                                  :comment (str "look up " (sql/render key)))
                     top   (here ctx)
                     rregs (column-loads! ctx right-schema
                                          (fn [i r col] (emit! ctx :Column :p1 c :p2 i :p3 r :comment (str "r" r " = " col))))]
                 (if inner-filter
                   (let [r    (expr! ctx (zipmap right-schema rregs) inner-filter)
                         skip (emit! ctx :IfNot :p1 r :comment (str "FILTER " (sql/render inner-filter)))]
                     (consume (into lregs rregs))
                     (patch! ctx skip :p2))
                   (consume (into lregs rregs)))
                 (emit! ctx :IndexNext :p1 c :p2 top)
                 (patch! ctx miss :p3))))))

(defmethod produce :hash-agg [ctx {:keys [input group-by aggs schema]} consume]
  (let [a   (alloc! ctx :aggs)
        fns (mapv agg/fn-name aggs)]
    (emit! ctx :AggOpen :p1 a :p4 {:fns fns :n-keys (count group-by)}
           :comment (str "GROUP BY " (str/join ", " (map sql/render group-by))))
    (produce ctx input
             (fn [regs]
               (let [env  (zipmap (:schema input) regs)
                     ks   (mapv #(expr! ctx env %) group-by)
                     vs   (mapv (fn [[_ _ arg :as e]]
                                  (if (= :* arg)
                                    (let [r (alloc! ctx :registers)] (emit! ctx :Integer :p2 r :p4 1) r)
                                    (expr! ctx env arg)))
                                aggs)
                     kbase (if (seq ks) (contiguous! ctx ks) 0)
                     vbase (contiguous! ctx vs)]
                 (emit! ctx :AggStep :p1 a :p2 kbase :p3 (count ks) :p4 vbase
                        :comment (str/join ", " (map sql/render aggs))))))
    (let [empty (emit! ctx :AggRewind :p1 a :comment "aggregation done; loop over groups")
          top   (here ctx)
          regs  (column-loads! ctx schema
                               (fn [i r col] (emit! ctx :AggColumn :p1 a :p2 i :p3 r :comment (str "r" r " = " col))))]
      (consume regs)
      (emit! ctx :AggNext :p1 a :p2 top)
      (patch! ctx empty :p2))))

(defmethod produce :sort [ctx {:keys [input keys schema]} consume]
  (let [s  (alloc! ctx :sorters)
        nk (count keys)]
    (emit! ctx :SorterOpen :p1 s :p4 (vec (map-indexed (fn [i k] [i (:desc? k)]) keys))
           :comment (str "ORDER BY " (str/join ", " (map #(str (sql/render (:expr %)) (when (:desc? %) " DESC")) keys))))
    (produce ctx input
             (fn [regs]
               ;; a sorter record is [sort keys … row columns …]
               (let [env (zipmap (:schema input) regs)
                     ks  (mapv #(expr! ctx env (:expr %)) keys)]
                 (emit! ctx :SorterInsert :p1 s :p2 (contiguous! ctx (into ks regs)) :p3 (+ nk (count regs))))))
    (let [empty (emit! ctx :SorterSort :p1 s :comment "sort; empty → skip loop")
          top   (here ctx)
          regs  (column-loads! ctx schema
                               (fn [i r col] (emit! ctx :SorterColumn :p1 s :p2 (+ nk i) :p3 r :comment (str "r" r " = " col))))]
      (consume regs)
      (emit! ctx :SorterNext :p1 s :p2 top)
      (patch! ctx empty :p2))))

;;; -------------------------------------------------- program -------------------------------------------------

(defn compile-plan
  "Physical plan → {:code [instruction …] :registers n :columns [...]}. The root's rows go to
  ResultRow; LIMIT exits jump to the final Halt."
  [plan]
  (let [ctx (new-ctx)]
    (emit! ctx :Init :p2 1)
    (produce ctx plan
             (fn [regs]
               (emit! ctx :ResultRow :p1 (contiguous! ctx regs) :p2 (count regs) :comment "output row")))
    (let [halt (emit! ctx :Halt)]
      (doseq [addr (:exits @ctx)]
        (vswap! ctx assoc-in [:code addr :p2] halt)))
    {:code      (:code @ctx)
     :registers (:registers @ctx)
     :columns   (:schema plan)}))
