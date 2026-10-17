-- A code answer must cite a location a developer can open, not merely a file.
alter table chunks add column start_line int;
alter table chunks add column end_line int;

alter table chunks add constraint chunks_line_range
  check ((start_line is null and end_line is null)
      or (start_line >= 1 and end_line >= start_line));
