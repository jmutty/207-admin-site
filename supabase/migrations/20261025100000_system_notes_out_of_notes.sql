-- System notes out of the notes boxes (2026-10-24). Jeremiah: "You can remove all these notes you added everywhere.
-- They are irrelevant." Every partner note so far was written by the system or a Claude cleanup ("Contacts added from
-- Gmail: ...", "Merged in ...", "Decline reply drafted in Gmail ...", and a few cleanup remarks), none typed by staff.
--
-- Nothing is thrown away: those rows change kind, so the Latest notes boxes and lists (notes_peek reads kind 'note')
-- and the Overview's Recent activity skip them, and they stay on the partner's Notes & history as history.
--   'merge'       the Merge into... records
--   'system_note' everything else the system wrote
-- To undo: update public.prospect_activities set kind = 'note' where kind in ('merge', 'system_note');
--
-- From here on partner_merge() writes kind 'merge', so merges never land in the notes again. Notes people type in
-- the app stay kind 'note'.

update public.prospect_activities set kind = 'merge'
 where kind = 'note' and (body like 'Merged in "%' or body like 'Merged into "%');

update public.prospect_activities set kind = 'system_note'
 where kind = 'note' and created_at < '2026-10-24 15:20:00+00'
   and (created_by is null
        or body like 'Contacts added from Gmail:%'
        or body like 'Decline reply drafted in Gmail%'
        or source_key like 'decline-draft:%');

-- partner_merge(): write its two records as kind 'merge'.
do $$
declare v_def text; v_new text;
begin
  select pg_get_functiondef('public.partner_merge(uuid, uuid)'::regprocedure) into v_def;
  v_new := replace(replace(v_def, '(p_keep, ''note'', ''Merged in', '(p_keep, ''merge'', ''Merged in'),
                                  '(p_other, ''note'', ''Merged into', '(p_other, ''merge'', ''Merged into');
  if v_new = v_def then
    if position('''merge'', ''Merged in' in v_def) > 0 then return; end if; -- already done
    raise exception 'partner_merge: the note lines were not found, nothing changed';
  end if;
  execute v_new;
end $$;
