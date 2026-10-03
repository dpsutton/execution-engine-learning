package engine

import "sort"

// BTree is an in-memory B+tree from a column value to the ids of the rows holding it.
//
// Internal nodes hold separator keys and children; leaves hold the keys, the row-id lists, and a
// pointer to the next leaf so a range scan can walk sideways without going back up. Order is the
// maximum number of children of an internal node (and keys in a leaf).
type BTree struct {
	Order  int
	root   *bnode
	Height int
	Keys   int // distinct keys
}

type bnode struct {
	leaf bool
	keys []Value
	vals [][]int  // leaves: row ids per key
	kids []*bnode // internal: len(kids) == len(keys)+1
	next *bnode   // leaves: right sibling
}

func NewBTree(order int) *BTree {
	if order < 3 {
		order = 3
	}
	return &BTree{Order: order, root: &bnode{leaf: true}, Height: 1}
}

// Insert adds (key, rowID). Duplicate keys share one entry with a growing row-id list.
func (t *BTree) Insert(key Value, rowID int) {
	sep, right := t.insert(t.root, key, rowID)
	if right != nil { // the root split: grow the tree by one level
		t.root = &bnode{keys: []Value{sep}, kids: []*bnode{t.root, right}}
		t.Height++
	}
}

// insert returns a (separator, new right sibling) pair when n had to split.
func (t *BTree) insert(n *bnode, key Value, rowID int) (Value, *bnode) {
	if n.leaf {
		i := sort.Search(len(n.keys), func(i int) bool { return Compare(n.keys[i], key) >= 0 })
		if i < len(n.keys) && Compare(n.keys[i], key) == 0 {
			n.vals[i] = append(n.vals[i], rowID)
			return nil, nil
		}
		n.keys = insertAt(n.keys, i, key)
		n.vals = insertAt(n.vals, i, []int{rowID})
		t.Keys++
		if len(n.keys) < t.Order {
			return nil, nil
		}
		mid := len(n.keys) / 2
		right := &bnode{leaf: true, next: n.next}
		right.keys = append([]Value(nil), n.keys[mid:]...)
		right.vals = append([][]int(nil), n.vals[mid:]...)
		n.keys, n.vals, n.next = n.keys[:mid:mid], n.vals[:mid:mid], right
		return right.keys[0], right // leaf split: the separator is copied up
	}

	i := childIndex(n, key)
	sep, right := t.insert(n.kids[i], key, rowID)
	if right == nil {
		return nil, nil
	}
	n.keys = insertAt(n.keys, i, sep)
	n.kids = insertAt(n.kids, i+1, right)
	if len(n.kids) <= t.Order {
		return nil, nil
	}
	mid := len(n.keys) / 2
	up := n.keys[mid] // internal split: the middle key moves up
	r := &bnode{
		keys: append([]Value(nil), n.keys[mid+1:]...),
		kids: append([]*bnode(nil), n.kids[mid+1:]...),
	}
	n.keys, n.kids = n.keys[:mid:mid], n.kids[:mid+1:mid+1]
	return up, r
}

// childIndex picks the child to descend into: keys equal to a separator live on its right.
func childIndex(n *bnode, key Value) int {
	return sort.Search(len(n.keys), func(i int) bool { return Compare(n.keys[i], key) > 0 })
}

func insertAt[T any](s []T, i int, v T) []T {
	s = append(s, v)
	copy(s[i+1:], s[i:])
	s[i] = v
	return s
}

// Search returns the row ids for one key (nil if absent).
func (t *BTree) Search(key Value) []int {
	n := t.root
	for !n.leaf {
		n = n.kids[childIndex(n, key)]
	}
	i := sort.Search(len(n.keys), func(i int) bool { return Compare(n.keys[i], key) >= 0 })
	if i < len(n.keys) && Compare(n.keys[i], key) == 0 {
		return append([]int(nil), n.vals[i]...)
	}
	return nil
}

// Range returns row ids for keys within [lo, hi] (each bound optional via nil, and inclusive or
// not), in key order. It descends once to the first leaf, then follows next pointers.
func (t *BTree) Range(lo, hi Value, loIncl, hiIncl bool) []int {
	n := t.root
	for !n.leaf {
		if lo == nil {
			n = n.kids[0]
		} else {
			n = n.kids[childIndex(n, lo)]
		}
	}
	var out []int
	for ; n != nil; n = n.next {
		for i, k := range n.keys {
			if lo != nil {
				c := Compare(k, lo)
				if c < 0 || (c == 0 && !loIncl) {
					continue
				}
			}
			if hi != nil {
				c := Compare(k, hi)
				if c > 0 || (c == 0 && !hiIncl) {
					return out
				}
			}
			out = append(out, n.vals[i]...)
		}
	}
	return out
}
