-- Module-scoped access (2026-10-21). Depends on 20261021120000_team_access_foundation.
--
-- Every RLS policy and admin RPC that said is_admin() now says which module it belongs to:
--   reads  -> can_any(<modules>, 'view')
--   writes -> can_any(<modules>, 'edit')
-- Full-access people (admin_users) pass every can_any() check, so the owner sees no difference.
-- Team members get exactly the modules on their Team page entry.
--
-- The policies/functions are patched in place from the mapping tables below (pg_get_functiondef + one
-- regexp_replace), so the rest of each definition stays exactly as deployed. The migration aborts if any
-- is_admin()-gated table or function is missing from the mapping, or a patch doesn't match exactly once,
-- so nothing is left half-converted. Things deliberately left as is_admin() (full access only) are listed.

create temporary table _tbl (tbl text primary key, view_mods text[] not null, edit_mods text[] not null) on commit drop;
insert into _tbl values
  -- Jobs
  ('bookings',               '{bookings}',                         '{bookings}'),
  ('booking_days',           '{bookings}',                         '{bookings}'),
  ('booking_emails',         '{bookings,partners}',                '{bookings}'),
  ('booking_coaches',        '{bookings}',                         '{bookings}'),
  ('booking_types',          '{bookings}',                         '{bookings}'),
  ('booking_sequences',      '{bookings}',                         '{bookings}'),
  ('booking_steps',          '{bookings}',                         '{bookings}'),
  ('booking_settings',       '{bookings}',                         '{bookings}'),
  ('calendar_events',        '{bookings}',                         '{bookings}'),
  ('synced_jobs',            '{galleries,findmyphotos,bookings,parents,hub}', '{galleries}'),
  ('job_type_rules',         '{galleries,findmyphotos}',           '{galleries,findmyphotos}'),
  ('job_categories',         '{galleries,findmyphotos}',           '{galleries,findmyphotos}'),
  ('comm_hub_schools',       '{hub,bookings}',                     '{hub,bookings}'),
  -- Parents
  ('lookup_requests',        '{parents}',                          '{parents}'),
  ('retake_requests',        '{parents}',                          '{parents}'),
  ('lookup_events',          '{findmyphotos,galleries,parents}',   '{findmyphotos}'),
  ('lookup_blocks',          '{findmyphotos}',                     '{findmyphotos}'),
  ('lookup_ip_blocks',       '{findmyphotos}',                     '{findmyphotos}'),
  ('lookup_ip_trusted',      '{findmyphotos}',                     '{findmyphotos}'),
  ('shared_ip_alerts',       '{findmyphotos}',                     '{findmyphotos}'),
  -- Partners
  ('prospect_orgs',          '{partners}',                         '{partners}'),
  ('prospect_contacts',      '{partners,bookings}',                '{partners}'),
  ('prospect_activities',    '{partners}',                         '{partners}'),
  ('prospect_enrollments',   '{partners}',                         '{partners}'),
  ('prospect_followups',     '{partners}',                         '{partners}'),
  ('prospect_me_towns',      '{partners}',                         '{partners}'),
  ('prospect_past_outreach', '{partners}',                         '{partners}'),
  ('prospect_saved_views',   '{partners}',                         '{partners}'),
  ('prospect_scheduled_emails', '{partners}',                      '{partners}'),
  ('prospect_send_log',      '{partners}',                         '{partners}'),
  ('prospect_sequence_steps','{partners}',                         '{partners}'),
  ('prospect_sequences',     '{partners}',                         '{partners}'),
  ('prospect_settings',      '{partners}',                         '{partners}'),
  ('prospect_snippets',      '{partners}',                         '{partners}'),
  ('prospect_sport_seasons', '{partners}',                         '{partners}'),
  ('prospect_threads',       '{partners}',                         '{partners}'),
  ('objects',                '{partners}',                         '{partners}');   -- storage: prospect-attachments bucket
-- Full access only (unchanged): admin_settings (sending / digest settings), gotphoto_orders, photo_releases.
-- sync_runs is read by the header sync status on every page: any team member.

create temporary table _fn (fn regprocedure primary key, mods text[], lvl text) on commit drop;
insert into _fn values
  -- Bookings
  ('public.admin_bookings(date, date)',                 '{bookings}', 'view'),
  ('public.admin_booking_detail(uuid)',                 '{bookings}', 'view'),
  ('public.admin_bookings_attention()',                 '{bookings}', 'view'),
  ('public.booking_email_preview(uuid)',                '{bookings}', 'view'),
  ('public.booking_job_candidates(uuid)',               '{bookings}', 'view'),
  ('public.booking_adopt_calendar_date(uuid)',          '{bookings}', 'edit'),
  ('public.booking_cancel(uuid)',                       '{bookings}', 'edit'),
  ('public.booking_coach_remove(uuid)',                 '{bookings}', 'edit'),
  ('public.booking_coaches_add(uuid, text, text)',            '{bookings}', 'edit'),
  ('public.booking_create(jsonb)',                      '{bookings}', 'edit'),
  ('public.booking_link_job(uuid, text)',               '{bookings}', 'edit'),
  ('public.booking_resend(uuid)',                       '{bookings}', 'edit'),
  ('public.booking_rewrite_calendar(uuid)',             '{bookings}', 'edit'),
  ('public.booking_send_now(uuid)',                     '{bookings}', 'edit'),
  ('public.booking_set_access_code(uuid, text, date)',        '{bookings}', 'edit'),
  ('public.booking_update(uuid, jsonb)',                '{bookings}', 'edit'),
  -- Galleries
  ('public.admin_job_field_coverage(text)',             '{galleries,findmyphotos}', 'view'),
  -- Hub
  ('public.admin_hub_activity()',                       '{hub}', 'view'),
  ('public.admin_hub_watcher_add(text, text, text, text)', '{hub}', 'edit'),
  ('public.admin_hub_watcher_remove(text, uuid)',       '{hub}', 'edit'),
  ('public.admin_hub_watcher_update(text, uuid, text, text)', '{hub}', 'edit'),
  -- Parent help
  ('public.admin_request_matches(uuid)',                '{parents}', 'view'),
  ('public.admin_request_searches(uuid)',               '{parents}', 'view'),
  ('public.lookup_request_reply(uuid, text, text, text, text)',           '{parents}', 'edit'),
  ('public.admin_makeups()',                            '{parents}', 'view'),
  ('public.admin_makeup_jobs()',                        '{parents}', 'view'),
  ('public.makeup_ready_email(uuid, text, text, text)',                   '{parents}', 'view'),
  ('public.admin_makeup_set(uuid, text, boolean)',      '{parents}', 'edit'),
  ('public.makeup_send_ready(uuid, text, text, text, boolean)',                    '{parents}', 'edit'),
  ('public.admin_retakes(integer)',                     '{parents}', 'view'),
  ('public.admin_retake_delete(uuid)',                  '{parents}', 'edit'),
  ('public.admin_retake_mark_handled(uuid)',            '{parents}', 'edit'),
  -- Find My Photos
  ('public.admin_lookup_blocks()',                      '{findmyphotos}', 'view'),
  ('public.admin_ip_searches(text)',                    '{findmyphotos}', 'view'),
  ('public.admin_job_searches(text, integer)',          '{findmyphotos,galleries}', 'view'),
  ('public.admin_block_ip(text, text, integer)',        '{findmyphotos}', 'edit'),
  ('public.admin_unblock_ip(text)',                     '{findmyphotos}', 'edit'),
  ('public.admin_trust_ip(text, text, boolean)',        '{findmyphotos}', 'edit'),
  -- Organizations & outreach
  ('public.admin_outbox(integer)',                      '{partners}', 'view'),
  ('public.prospect_prior_contact(text, text[])',               '{partners}', 'view'),
  ('public.prospect_reply_queue(integer)',                     '{partners}', 'view'),
  ('public.prospect_approve(uuid)',                     '{partners}', 'edit'),
  ('public.prospect_approve_quick(uuid[])',             '{partners}', 'edit'),
  ('public.prospect_contact_action(uuid, text)',        '{partners}', 'edit'),
  ('public.prospect_enroll(jsonb, jsonb, text, boolean, boolean)',                      '{partners}', 'edit'),
  ('public.prospect_enroll_org(uuid, uuid[], text, text)',                  '{partners}', 'edit'),
  ('public.prospect_import_orgs(jsonb, boolean)',                '{partners}', 'edit'),
  ('public.prospect_mark_declined(uuid, text)',               '{partners}', 'edit'),
  ('public.prospect_merge_orgs(uuid, uuid)',            '{partners}', 'edit'),
  ('public.prospect_quick_draft(uuid[], text, text, text, boolean)',                 '{partners}', 'edit'),
  ('public.prospect_schedule_oneoff(uuid, text, text, timestamp with time zone)',            '{partners}', 'edit'),
  ('public.prospect_set_status(uuid, text)',            '{partners}', 'edit');
-- Full access only (unchanged): admin_morning_digest (Settings) and the team_* functions (Team page). Already team-aware since the
-- foundation migration: admin_devices_list, admin_forget_device, admin_remember_device.

-- ---------------------------------------------------------------- policies
do $$
declare
  p record; t record; v_view text; v_edit text; v_roles text; v_using text; v_check text; v_left int;
  c_pat constant text := '(public\.)?is_admin\(\)';
begin
  for p in
    select pol.schemaname, pol.tablename, pol.policyname, pol.permissive, pol.cmd, pol.roles, pol.qual, pol.with_check
      from pg_policies pol
     where pol.schemaname in ('public', 'storage')
       and (coalesce(pol.qual, '') ~ c_pat or coalesce(pol.with_check, '') ~ c_pat)
       and not (pol.schemaname = 'public' and pol.tablename in ('admin_settings', 'gotphoto_orders', 'photo_releases', 'sync_runs'))
  loop
    select * into t from _tbl where tbl = p.tablename;
    if not found then raise exception 'no module mapping for %.% (policy %)', p.schemaname, p.tablename, p.policyname; end if;
    v_view := format('public.can_any(%L, %L)', t.view_mods, 'view');
    v_edit := format('public.can_any(%L, %L)', t.edit_mods, 'edit');
    v_roles := (select string_agg(case when r = 'public' then 'public' else quote_ident(r) end, ', ') from unnest(p.roles) r);

    if p.cmd = 'SELECT' then
      execute format('alter policy %I on %I.%I using (%s)', p.policyname, p.schemaname, p.tablename, regexp_replace(p.qual, c_pat, v_view, 'g'));
    elsif p.cmd = 'INSERT' then
      execute format('alter policy %I on %I.%I with check (%s)', p.policyname, p.schemaname, p.tablename, regexp_replace(p.with_check, c_pat, v_edit, 'g'));
    else
      -- UPDATE / DELETE / ALL: the policy itself now needs edit ...
      v_using := case when p.qual is not null then format(' using (%s)', regexp_replace(p.qual, c_pat, v_edit, 'g')) else '' end;
      v_check := case when p.with_check is not null then format(' with check (%s)', regexp_replace(p.with_check, c_pat, v_edit, 'g')) else '' end;
      execute format('alter policy %I on %I.%I%s%s', p.policyname, p.schemaname, p.tablename, v_using, v_check);
      -- ... and an ALL policy gets a read-only twin so view-level people can still read.
      if p.cmd = 'ALL' then
        execute format('create policy %I on %I.%I as %s for select to %s using (%s)',
                       left(p.policyname, 56) || ' (read)', p.schemaname, p.tablename, p.permissive, v_roles,
                       regexp_replace(p.qual, c_pat, v_view, 'g'));
      end if;
    end if;
  end loop;

  -- The sync-status header is on every page.
  alter policy admin_read_runs on public.sync_runs using ((select public.is_team_member()));

  select count(*) into v_left from pg_policies pol
   where pol.schemaname in ('public', 'storage') and (coalesce(pol.qual, '') ~ c_pat or coalesce(pol.with_check, '') ~ c_pat)
     and not (pol.schemaname = 'public' and pol.tablename in ('admin_settings', 'gotphoto_orders', 'photo_releases'));
  if v_left > 0 then raise exception '% policies still use is_admin()', v_left; end if;
end $$;

-- ---------------------------------------------------------------- functions
do $$
declare
  f record; v_def text; v_n int; v_missing text;
  c_pat constant text := '(public\.)?is_admin\(\)';
begin
  select string_agg(p.oid::regprocedure::text, ', ') into v_missing
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prokind = 'f'
     and p.proname not in ('is_admin', 'admin_morning_digest', 'team_list', 'team_save', 'team_set_active', 'team_flag_password', 'team_audit_list')
     and pg_get_functiondef(p.oid) ~ c_pat
     and p.oid not in (select fn from _fn);
  if v_missing is not null then raise exception 'no module mapping for function(s): %', v_missing; end if;

  for f in select * from _fn loop
    v_def := pg_get_functiondef(f.fn);
    select count(*) into v_n from regexp_matches(v_def, c_pat, 'g');
    if v_n <> 1 then raise exception '%: expected 1 is_admin() call, found %', f.fn, v_n; end if;
    execute regexp_replace(v_def, c_pat, format('public.can_any(%L, %L)', f.mods, f.lvl), 'g');
  end loop;
end $$;

-- ---------------------------------------------------------------- helpers that had no check of their own
-- These were only reachable by the owner (the only signed-in account). None is called by the app or by any
-- SECURITY INVOKER code, only from inside SECURITY DEFINER functions (which run as their owner), so
-- signed-in people no longer need to call them directly.
revoke execute on function public.prospect_org_refresh(uuid), public.prospect_pick_peer(uuid), public.prospect_pick_quote(uuid, uuid),
  public.prospect_followup_date(uuid), public.booking_schedule_words(uuid) from authenticated;
-- The Organizations page calls prospect_sequence_rank directly: limit it to people with partners access.
do $$
declare v_def text := pg_get_functiondef('public.prospect_sequence_rank(uuid)'::regprocedure); v_n int;
begin
  select count(*) into v_n from regexp_matches(v_def, 'from prospect_orgs where id = p_org\)', 'g');
  if v_n <> 1 then raise exception 'prospect_sequence_rank: expected 1 match, found %', v_n; end if;
  execute regexp_replace(v_def, 'from prospect_orgs where id = p_org\)', 'from prospect_orgs where id = p_org and public.can_any(''{partners}'', ''view''))');
end $$;
