-- 005_series_year_counts.sql
-- Adds a book's optional series name, and year counts: the number of books someone read in a year before they
-- started using Readeez. Every change only adds something with a safe default, so it can run against a live
-- database and older code keeps working if rolled back (older code would show a year count as an ordinary book).

-- The series a book belongs to, e.g. "Discworld". Empty for a book that isn't part of one.
alter table books add column series text not null default '';

-- 'book' is an ordinary book or box. 'tally' is a year count: a row holding only a year and how many books were
-- read in it, stored with the books so it syncs, backs up and exports with no new machinery.
alter table books add column kind text not null default 'book';
-- How many books a year count stands for. Empty for every other row.
alter table books add column tally_count integer;

-- The database refuses impossible combinations even if a bug got past bookValidation.js: only a year count has a
-- count, every year count has one between 1 and 10000, and a deleted marker (which is emptied) may have none.
alter table books add constraint books_kind_check check (
  (kind = 'book' and tally_count is null)
  or (kind = 'tally' and (deleted or tally_count between 1 and 10000))
);
