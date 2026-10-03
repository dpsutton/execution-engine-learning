(ns lesson05.btree
  "A B+tree, built the way a disk-based database thinks about it: as a set of numbered PAGES.

  The tree is an immutable map:

      {:order 4                      max children per internal node (so ≤ order-1 keys per node)
       :root  0                      page id of the root
       :nodes {0 {...} 1 {...}}      page id → node
       :next-id 2}

  A leaf page holds sorted keys, and for each key the vector of row ids having it (a \"posting
  list\", so duplicate keys are fine), plus a link to the next leaf:

      {:leaf? true  :keys [3 5 8] :vals [[0] [4 9] [2]] :next 7}

  An internal page holds separator keys and child page ids. Child i holds keys < keys[i];
  child i+1 holds keys ≥ keys[i]:

      {:leaf? false :keys [5 9] :children [1 3 6]}

  Why pages-in-a-map instead of nested maps? Because that's what an index really is: pages that
  point at other pages by number. Counting how many pages a search touches (`:visits`) is counting
  disk reads. And because the map is a value, `insert` returns a new tree and the old one is
  untouched — handy for the demo's before/after printing.

  Persistent vs mutable: a real engine mutates pages in place (they're in a buffer pool). Here,
  `assoc-in` on a map of pages does the same job with structural sharing; the algorithm is
  identical."
  (:require [clojure.string :as str]))

(defn compare-keys
  "Total order on non-NULL keys: numbers numerically, strings lexicographically."
  [a b]
  (if (and (number? a) (number? b))
    (if (and (int? a) (int? b)) (compare (long a) (long b)) (compare (double a) (double b)))
    (compare a b)))

(defn- lower-bound
  "First index i with keys[i] >= k (binary search)."
  [keys k]
  (loop [lo 0 hi (count keys)]
    (if (< lo hi)
      (let [mid (quot (+ lo hi) 2)]
        (if (neg? (compare-keys (keys mid) k)) (recur (inc mid) hi) (recur lo mid)))
      lo)))

(defn- upper-bound
  "First index i with keys[i] > k. Used to pick a child: keys equal to a separator go right."
  [keys k]
  (loop [lo 0 hi (count keys)]
    (if (< lo hi)
      (let [mid (quot (+ lo hi) 2)]
        (if (pos? (compare-keys (keys mid) k)) (recur lo mid) (recur (inc mid) hi)))
      lo)))

(defn- vec-insert [v i x] (into (conj (subvec v 0 i) x) (subvec v i)))

(defn empty-tree
  "A tree with a single empty leaf as its root."
  [order]
  (assert (>= order 3) "order must be at least 3")
  {:order order :root 0 :nodes {0 {:leaf? true :keys [] :vals [] :next nil}} :next-id 1})

(defn- alloc
  "Store `node` in a fresh page; return [tree page-id]."
  [tree node]
  (let [id (:next-id tree)]
    [(-> tree (assoc-in [:nodes id] node) (update :next-id inc)) id]))

(defn- split-leaf
  "Split an overfull leaf in half. The right half's first key becomes the separator pushed up,
  and it is COPIED up — it stays in the leaf, because all keys must live in the leaves."
  [tree id {:keys [keys vals next]}]
  ;; EXERCISE(btree-split): Move the upper half of the leaf's keys/vals to a new page (alloc), keep the
  ;; lower half in page `id`, and fix the :next links so the leaf chain stays in order. Return
  ;; [tree {:key first-key-of-right-half :right new-page-id}] for the parent.
  (let [mid          (quot (count keys) 2)
        right        {:leaf? true :keys (subvec keys mid) :vals (subvec vals mid) :next next}
        [tree rid]   (alloc tree right)
        left         {:leaf? true :keys (subvec keys 0 mid) :vals (subvec vals 0 mid) :next rid}]
    [(assoc-in tree [:nodes id] left) {:key (first (:keys right)) :right rid}])
  ;; END EXERCISE
  )

(defn- split-internal
  "Split an overfull internal node. The middle key MOVES up: it separates the two halves and is
  not kept in either."
  [tree id {:keys [keys children]}]
  (let [mid        (quot (count keys) 2)
        right      {:leaf? false :keys (subvec keys (inc mid)) :children (subvec children (inc mid))}
        [tree rid] (alloc tree right)
        left       {:leaf? false :keys (subvec keys 0 mid) :children (subvec children 0 (inc mid))}]
    [(assoc-in tree [:nodes id] left) {:key (keys mid) :right rid}]))

(defn- insert-at
  "Insert into the subtree rooted at page `id`. Returns [tree split], where split is nil or
  {:key separator :right new-page-id} for the parent to absorb."
  [tree id k row-id]
  (let [node  (get-in tree [:nodes id])
        order (:order tree)]
    (if (:leaf? node)
      (let [{:keys [keys]} node
            i    (lower-bound keys k)
            node (if (and (< i (count keys)) (zero? (compare-keys (keys i) k)))
                   (update-in node [:vals i] conj row-id)          ; existing key: extend posting list
                   (-> node (update :keys vec-insert i k) (update :vals vec-insert i [row-id])))]
        (if (>= (count (:keys node)) order)
          (split-leaf tree id node)
          [(assoc-in tree [:nodes id] node) nil]))
      (let [i            (upper-bound (:keys node) k)
            [tree split] (insert-at tree ((:children node) i) k row-id)]
        (if-not split
          [tree nil]
          (let [node (-> (get-in tree [:nodes id])
                         (update :keys vec-insert i (:key split))
                         (update :children vec-insert (inc i) (:right split)))]
            (if (>= (count (:keys node)) order)
              (split-internal tree id node)
              [(assoc-in tree [:nodes id] node) nil])))))))

(defn insert
  "Insert key `k` pointing at `row-id`. NULL keys aren't indexed (WHERE x = NULL never matches).
  When the root splits, a new root is made above it — the only way a B+tree grows taller, which is
  why every leaf is always at the same depth."
  [tree k row-id]
  (if (nil? k)
    tree
    (let [[tree split] (insert-at tree (:root tree) k row-id)]
      (if-not split
        tree
        (let [[tree new-root] (alloc tree {:leaf? false :keys [(:key split)]
                                           :children [(:root tree) (:right split)]})]
          (assoc tree :root new-root))))))

(defn- descend
  "Walk from the root to the leaf that would hold `k` (leftmost leaf when k is nil).
  Returns [leaf-id pages-visited]."
  [tree k]
  ;; EXERCISE(btree-search): Start at the root page. At an internal page, follow the child whose key range
  ;; holds k (keys equal to a separator go right: upper-bound); nil k means leftmost. Stop at a leaf.
  ;; Count every page you read.
  (loop [id (:root tree) visits 1]
    (let [node (get-in tree [:nodes id])]
      (if (:leaf? node)
        [id visits]
        (recur ((:children node) (if (nil? k) 0 (upper-bound (:keys node) k))) (inc visits)))))
  ;; END EXERCISE
  )

(defn search
  "Row ids with key = `k`. Returns {:row-ids [...] :visits pages-read} — height pages, always."
  [tree k]
  (let [[leaf visits] (descend tree k)
        {:keys [keys vals]} (get-in tree [:nodes leaf])
        i (lower-bound keys k)]
    {:row-ids (if (and (< i (count keys)) (zero? (compare-keys (keys i) k))) (vals i) [])
     :visits  visits}))

(defn range-search
  "Row ids with lo <= key <= hi, in key order (nil bound = unbounded). Descend once to the first
  leaf, then follow :next links sideways — the reason B+trees keep all keys in linked leaves.
  Returns {:entries [[key row-ids] …] :visits pages-read}."
  [tree lo hi]
  ;; EXERCISE(btree-range): Descend once to the leaf where lo would be, then walk forward collecting
  ;; [key row-ids] until a key passes hi, following :next to the following leaf page when one runs out.
  (let [[leaf visits] (descend tree lo)]
    (loop [id leaf visits visits acc []
           i (if (nil? lo) 0 (lower-bound (:keys (get-in tree [:nodes leaf])) lo))]
      (let [{:keys [keys vals next]} (get-in tree [:nodes id])]
        (cond
          (< i (count keys))
          (if (and (some? hi) (pos? (compare-keys (keys i) hi)))
            {:entries acc :visits visits}
            (recur id visits (conj acc [(keys i) (vals i)]) (inc i)))
          (some? next) (recur next (inc visits) acc 0)
          :else {:entries acc :visits visits}))))
  ;; END EXERCISE
  )

(defn height [tree] (second (descend tree nil)))

(defn page-count [tree] (count (:nodes tree)))

(defn render
  "ASCII picture of the tree, root first, children indented. Leaves show their keys and (in
  braces) the page they link to."
  [tree]
  (let [lines (atom [])]
    (letfn [(walk [id depth]
              (let [{:keys [leaf? keys children next]} (get-in tree [:nodes id])
                    pad (apply str (repeat depth "    "))]
                (if leaf?
                  (swap! lines conj (str pad "p" id " leaf " (pr-str keys) (when next (str " → p" next))))
                  (do (swap! lines conj (str pad "p" id " [" (str/join " | " keys) "]"))
                      (doseq [c children] (walk c (inc depth)))))))]
      (walk (:root tree) 0))
    (str/join "\n" @lines)))

(defn build
  "Index column `col-idx` of `rows`: key = the column value, row id = the row's position."
  [rows col-idx order]
  (reduce (fn [t [row-id row]] (insert t (nth row col-idx) row-id))
          (empty-tree order)
          (map-indexed vector rows)))
