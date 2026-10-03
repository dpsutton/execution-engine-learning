(ns engine.btree
  "A persistent B+tree mapping a key to the row ids that hold it.

  Nodes are plain maps:

    leaf:     {:leaf? true  :keys [k0 k1 …] :vals [[rowid …] [rowid …] …]}
    internal: {:leaf? false :keys [s0 s1 …] :children [c0 c1 … c(n)]}

  In an internal node, child i holds keys k with s(i-1) <= k < s(i). Real B+trees link the leaves so
  a range scan can walk sideways; a persistent tree can't hold those pointers, so `range-rowids` does
  an in-order walk that skips subtrees outside the range — same visits, same output order.

  `order` is the maximum number of children of a node; a node splits when it reaches `order` keys.
  NULL keys are not indexed (they never match `=` or a range)."
  (:require [engine.value :as v]))

(defn empty-tree [order]
  {:order order :root {:leaf? true :keys [] :vals []} :size 0})

(defn- key-position
  "Index of the first key in `keys` that is >= k (binary search)."
  [keys k]
  (loop [lo 0 hi (count keys)]
    (if (< lo hi)
      (let [mid (quot (+ lo hi) 2)]
        (if (neg? (v/compare-values (nth keys mid) k))
          (recur (inc mid) hi)
          (recur lo mid)))
      lo)))

(defn- child-index
  "Which child of an internal node may hold k: the number of separators <= k."
  [keys k]
  (loop [lo 0 hi (count keys)]
    (if (< lo hi)
      (let [mid (quot (+ lo hi) 2)]
        (if (pos? (v/compare-values (nth keys mid) k))
          (recur lo mid)
          (recur (inc mid) hi)))
      lo)))

(defn- vec-insert [v i x] (into (conj (subvec v 0 i) x) (subvec v i)))

(defn- split-leaf
  "Split a full leaf in half. The separator pushed up is the first key of the right half."
  [{:keys [keys vals]}]
  (let [mid (quot (count keys) 2)]
    [{:leaf? true :keys (subvec keys 0 mid) :vals (subvec vals 0 mid)}
     (nth keys mid)
     {:leaf? true :keys (subvec keys mid) :vals (subvec vals mid)}]))

(defn- split-internal
  "Split a full internal node: the middle separator moves up and belongs to neither half."
  [{:keys [keys children]}]
  (let [mid (quot (count keys) 2)]
    [{:leaf? false :keys (subvec keys 0 mid) :children (subvec children 0 (inc mid))}
     (nth keys mid)
     {:leaf? false :keys (subvec keys (inc mid)) :children (subvec children (inc mid))}]))

(defn- insert-node
  "Insert into the subtree at `node`. Returns [node] or, if it split, [left separator right]."
  [order node k rowid]
  (if (:leaf? node)
    (let [{:keys [keys vals]} node
          i (key-position keys k)]
      (if (and (< i (count keys)) (zero? (v/compare-values (nth keys i) k)))
        [(update-in node [:vals i] conj rowid)]                       ; existing key: add a row id
        (let [node' (assoc node :keys (vec-insert keys i k) :vals (vec-insert vals i [rowid]))]
          (if (>= (count (:keys node')) order) (split-leaf node') [node']))))
    (let [{:keys [keys children]} node
          i      (child-index keys k)
          result (insert-node order (nth children i) k rowid)
          node'  (if (= 1 (count result))
                   (assoc-in node [:children i] (first result))
                   (let [[l sep r] result]
                     (assoc node
                            :keys (vec-insert keys i sep)
                            :children (-> children (assoc i l) (vec-insert (inc i) r)))))]
      (if (>= (count (:keys node')) order) (split-internal node') [node']))))

(defn insert
  "Add `rowid` under key `k`. A split root grows the tree by one level."
  [{:keys [order root] :as tree} k rowid]
  (if (nil? k)
    tree
    (let [result (insert-node order root k rowid)
          root'  (if (= 1 (count result))
                   (first result)
                   (let [[l sep r] result] {:leaf? false :keys [sep] :children [l r]}))]
      (-> tree (assoc :root root') (update :size inc)))))

(defn lookup
  "Row ids whose key equals k, in insertion order. [] if none or k is NULL."
  [{:keys [root]} k]
  (if (nil? k)
    []
    (loop [node root]
      (if (:leaf? node)
        (let [i (key-position (:keys node) k)]
          (if (and (< i (count (:keys node))) (zero? (v/compare-values (nth (:keys node) i) k)))
            (nth (:vals node) i)
            []))
        (recur (nth (:children node) (child-index (:keys node) k)))))))

(defn- in-lower? [{:keys [value inclusive?]} k]
  (or (nil? value) (let [c (v/compare-values k value)] (if inclusive? (>= c 0) (pos? c)))))

(defn- in-upper? [{:keys [value inclusive?]} k]
  (or (nil? value) (let [c (v/compare-values k value)] (if inclusive? (<= c 0) (neg? c)))))

(defn range-rowids
  "Row ids for keys within [lo, hi], in key order. Bounds are {:value v :inclusive? bool};
  a nil bound (or nil :value) is unbounded on that side."
  [{:keys [root]} lo hi]
  (letfn [(walk [node]
            (if (:leaf? node)
              (mapcat (fn [k rowids] (when (and (in-lower? lo k) (in-upper? hi k)) rowids))
                      (:keys node) (:vals node))
              (let [ks (:keys node)]
                ;; Child i spans [ks[i-1], ks[i]); skip it if it lies entirely outside the range.
                (mapcat (fn [i child]
                          (let [child-lo (when (pos? i) (nth ks (dec i)))
                                child-hi (when (< i (count ks)) (nth ks i))]
                            ;; every key in the child is < child-hi and >= child-lo
                            (when (and (or (nil? child-hi) (nil? (:value lo))
                                           (pos? (v/compare-values child-hi (:value lo))))
                                       (or (nil? child-lo) (in-upper? hi child-lo)))
                              (walk child))))
                        (range) (:children node)))))]
    (vec (walk root))))

(defn depth
  "Number of levels, counting the leaf level."
  [{:keys [root]}]
  (loop [node root d 1] (if (:leaf? node) d (recur (first (:children node)) (inc d)))))
