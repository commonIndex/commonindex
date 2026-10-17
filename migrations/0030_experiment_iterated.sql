-- "Iterate" was recorded as status "killed". It is its own outcome: this
-- version is not shipped and the idea goes on to a follow-up. Experiments
-- already decided that way move to "iterated"; nothing else changes.
update objects
   set props = jsonb_set(props, '{status}', '"iterated"')
 where type = 'experiment'
   and props->>'status' = 'killed'
   and props->'decision'->>'outcome' = 'iterate';
