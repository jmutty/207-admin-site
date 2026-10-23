-- Quieter GotPhoto sync alerts (2026-10-24).
--
-- Before: a push every time the sync went from a good run to a failed one. The sync runs every 5 minutes and
-- blips about twice a day (a GotPhoto timeout at 12:05am and 11:05am Eastern), fixing itself on the very next
-- run, so that was two pushes a day about nothing.
--
-- Now:
--   no good sync for over an hour -> one push "GotPhoto sync is down" (cron push-sync-watch, every 5 min)
--   still down                    -> nothing more
--   first good sync after that    -> one push "GotPhoto sync is working again"
-- The watch looks at the last good run, not failed runs, so it also catches the sync not running at all.

create table public.sync_alert (
  id          boolean primary key default true check (id),
  alerted_at  timestamptz,           -- set when the "down" push went out; cleared by the first good run after it
  last_ok_at  timestamptz            -- last good sync as of that push
);
comment on table public.sync_alert is 'One row: whether a "GotPhoto sync is down" push is out, so it goes once per outage.';
insert into public.sync_alert (id) values (true);
alter table public.sync_alert enable row level security;   -- no policies: functions only

update public.push_topics
   set label = 'GotPhoto sync down',
       description = 'No good GotPhoto sync for over an hour, and when it is back.'
 where key = 'sync_failed';

create or replace function public.push_sync_watch()
returns void language plpgsql security definer set search_path = '' as $$
declare v_last_ok timestamptz; v_err text;
begin
  select max(r.started_at) into v_last_ok from public.sync_runs r where r.ok;
  if v_last_ok is null or v_last_ok > now() - interval '1 hour' then return; end if;
  if (select a.alerted_at from public.sync_alert a where a.id) is not null then return; end if;
  update public.sync_alert set alerted_at = now(), last_ok_at = v_last_ok where id;
  select r.error into v_err from public.sync_runs r where r.ok is false order by r.started_at desc limit 1;
  perform public.push_notify('sync_failed', 'GotPhoto sync is down',
    'No good sync since ' || to_char(v_last_ok at time zone 'America/New_York', 'FMHH12:MI am') ||
    '. Codes on Find My Photos may be out of date.' || coalesce(' ' || left(v_err, 120), ''),
    '/#system/health', 'sync_failed');
end $$;

-- The trigger now only sends the all-clear.
create or replace function public.push_on_sync_run()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_since timestamptz;
begin
  if new.ok is true and (tg_op = 'INSERT' or old.ok is distinct from true) then
    begin
      update public.sync_alert set alerted_at = null where id and alerted_at is not null
      returning last_ok_at into v_since;
      if found then
        perform public.push_notify('sync_failed', 'GotPhoto sync is working again',
          'Codes on Find My Photos are up to date.' ||
          coalesce(' It was down ' || (case when now() - v_since < interval '2 hours'
                                            then extract(epoch from now() - v_since)::int / 60 || ' minutes'
                                            else round(extract(epoch from now() - v_since) / 3600.0, 1)::text || ' hours' end) || '.', ''),
          '/#system/health', 'sync_ok');
      end if;
    exception when others then raise warning 'push_on_sync_run: %', sqlerrm;
    end;
  end if;
  return null;
end $$;

revoke all on function public.push_sync_watch(), public.push_on_sync_run() from public, anon, authenticated;

select cron.schedule('push-sync-watch', '*/5 * * * *', 'select public.push_sync_watch()');
