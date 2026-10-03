// Shared figure data for this topic: the toy dataset and the DESIGN.md PRNG.
(function () {
  const TOY = {
    customers: { columns: ["id", "name", "city", "age"], rows: [
      [1, "Ada", "Austin", 36], [2, "Bo", "Boston", null], [3, "Cy", "Austin", 52], [4, "Di", "Denver", 29]] },
    orders: { columns: ["id", "customer_id", "product_id", "qty"], rows: [
      [10, 1, 100, 2], [11, 1, 101, 1], [12, 3, 100, 5], [13, 4, 102, 1], [14, 9, 101, 3]] },
    products: { columns: ["id", "name", "category", "price"], rows: [
      [100, "Pen", "tools", 1.5], [101, "Atlas", "books", 24.0], [102, "Chess", "games", 18.25]] },
  };

  // Same PRNG as the engines (DESIGN.md) so visuals can show "real" generated data. BigInt for exact 64-bit math.
  function lcg(seed = 42n) {
    let state = BigInt(seed);
    const M = (1n << 64n) - 1n;
    const next = () => { state = (state * 6364136223846793005n + 1442695040888963407n) & M; return Number(state >> 33n); };
    return { next, intn: (n) => next() % n };
  }

  EE.TOY = TOY;
  EE.lcg = lcg;
})();
