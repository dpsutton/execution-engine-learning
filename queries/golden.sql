-- Cross-language golden queries: one per line. Every query has an ORDER BY so output is deterministic
-- regardless of join order chosen by the planner.
SELECT id, name, city, age FROM customers WHERE id <= 5 ORDER BY id
SELECT city, count(*) AS n FROM customers GROUP BY city ORDER BY n DESC, city
SELECT count(*), count(age), min(age), max(age), avg(age) FROM customers
SELECT name FROM customers WHERE age IS NULL ORDER BY name LIMIT 5
SELECT category, count(*) AS n, avg(price) AS avg_price FROM products GROUP BY category ORDER BY category
SELECT c.name, count(*) AS orders FROM customers c JOIN orders o ON o.customer_id = c.id GROUP BY c.name ORDER BY orders DESC, c.name LIMIT 10
SELECT c.city, sum(o.qty * p.price) AS revenue FROM customers c JOIN orders o ON o.customer_id = c.id JOIN products p ON p.id = o.product_id GROUP BY c.city ORDER BY revenue DESC
SELECT p.name, sum(o.qty) AS units FROM orders o, products p WHERE o.product_id = p.id AND p.category = 'games' GROUP BY p.name ORDER BY units DESC, p.name LIMIT 5
SELECT o.id, o.qty, o.day FROM orders o WHERE o.customer_id = 7 AND o.day > 300 ORDER BY o.day, o.id
SELECT c.name, o.day FROM customers c JOIN orders o ON o.customer_id = c.id WHERE c.city = 'Seattle' AND o.qty = 5 ORDER BY o.day DESC, c.name LIMIT 8
SELECT upper(city) AS city, count(*) AS n FROM customers WHERE age > 60 OR age IS NULL GROUP BY city HAVING count(*) > 2 ORDER BY n DESC, city
SELECT o.day, count(*) AS n, sum(o.qty) AS units FROM orders o WHERE o.day <= 3 GROUP BY o.day ORDER BY o.day
SELECT p.category, c.city, count(*) AS n FROM orders o JOIN customers c ON c.id = o.customer_id JOIN products p ON p.id = o.product_id WHERE c.age < 30 GROUP BY p.category, c.city ORDER BY n DESC, p.category, c.city LIMIT 6
SELECT id, price, price * 2 / 4 AS half, coalesce(NULL, name) AS nm FROM products WHERE price > 95 ORDER BY price DESC
