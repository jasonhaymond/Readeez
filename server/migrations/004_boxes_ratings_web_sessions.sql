-- 004_boxes_ratings_web_sessions.sql
-- Adds book boxes, per-category ratings and browser sessions. Every change only adds something with a
-- safe default, so it can run against a live database and older code keeps working if rolled back.

-- A book box stays one title with a count of the books inside. Both are empty for an ordinary book.
alter table books add column box_total smallint;
alter table books add column box_read smallint;
-- The database refuses impossible counts even if a bug got past bookValidation.js: a box has at
-- least two books, and a person can't have read more of them than it holds or read any of a non-box.
alter table books add constraint books_box_counts check (
  (box_total is null and box_read is null)
  or (box_total between 2 and 1000 and box_read between 0 and box_total)
);

-- Optional titles of the books inside a box. A person who only wants to count them never fills this in.
alter table books add column box_titles text[] not null default '{}';

-- Optional stars for each of the book's categories, as [{"category": "Fantasy", "rating": 5}].
-- A list rather than an object keyed by name, so a category called "__proto__" is only ever text.
alter table books add column category_ratings jsonb not null default '[]';

-- Marks a session started in a browser, whose idle limit differs from a phone's (see auth.js).
alter table sessions add column web boolean not null default false;
