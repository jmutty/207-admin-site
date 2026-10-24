-- Speed (2026-10-24): sports_hub_jobs matched calendar events for every sport job ever synced (~674), then kept
-- only the ~23 in the hub window, so it took ~3.5 s. It feeds hub_sends_all(), and through it admin_outbox
-- (Today, Outbox, the partner page) and admin_hub_activity. Same view, same columns and rows; the window is
-- applied before the calendar match (cand0 reads `win`, not `jobs`). ~75 ms on live data.
create or replace view public.sports_hub_jobs as
 WITH jobs AS (
         SELECT j.gotphoto_job_id,
            j.name,
            btrim(split_part(j.name, '|'::text, 1)) AS org_raw,
            (btrim(split_part(j.name, '|'::text, 1)) || ' '::text) || btrim(split_part(j.name, '|'::text, 2)) AS match_raw,
            replace(j.name, '|'::text, ' '::text) AS full_raw,
            (j.shoot_at AT TIME ZONE 'Europe/Berlin'::text)::date AS picture_day,
            COALESCE(( SELECT max((d.value ->> 'date'::text)::date) AS max
                   FROM jsonb_array_elements(
                        CASE
                            WHEN jsonb_typeof(j.hub_dates) = 'array'::text THEN j.hub_dates
                            ELSE '[]'::jsonb
                        END) d(value)
                  WHERE (d.value ->> 'date'::text) ~ '^\d{4}-\d{2}-\d{2}$'::text), (j.shoot_at AT TIME ZONE 'Europe/Berlin'::text)::date) AS last_day,
            j.status,
            j.access_type,
            j.job_type,
            j.gp_activated_at,
            j.hub_dates,
            j.roster_loaded_at,
            COALESCE(j.code_count, 0) AS code_count,
                CASE
                    WHEN j.comm_workflow IS NOT NULL THEN j.comm_workflow
                    WHEN j.access_type = 'single_password'::text THEN 'school'::text
                    ELSE COALESCE(r.comm_workflow, 'school'::text)
                END AS workflow,
                CASE
                    WHEN j.comm_workflow IS NOT NULL THEN 'set in code admin'::text
                    WHEN j.access_type = 'single_password'::text THEN 'shared team code'::text
                    ELSE 'job type '::text || j.job_type
                END AS workflow_reason
           FROM synced_jobs j
             LEFT JOIN job_type_rules r USING (job_type)
          WHERE j.job_type ~~ 'sport%'::text AND j.shoot_at IS NOT NULL
        ), win AS (
         SELECT jobs.* FROM jobs
          WHERE jobs.last_day >= (CURRENT_DATE - 5) AND jobs.last_day <= (CURRENT_DATE + 180)
        ), cand0 AS (
         SELECT jobs_1.gotphoto_job_id,
            e.google_event_id,
            e.start_date,
            e.end_date,
            e.all_day,
            e.start_at,
            e.end_at,
            e.summary,
            jobs_1.match_raw,
            jobs_1.full_raw,
            jobs_1.org_raw,
            sports_hub_type_part(e.summary, jobs_1.org_raw) AS type_part
           FROM win jobs_1
             JOIN calendar_events e ON e.start_date >= (jobs_1.picture_day - 14) AND e.start_date <= (jobs_1.picture_day + 45)
        ), cand AS (
         SELECT c0.gotphoto_job_id,
            c0.google_event_id,
            c0.start_date,
            c0.end_date,
            c0.all_day,
            c0.start_at,
            c0.end_at,
            c0.summary,
            c0.type_part,
            sports_hub_tokens(c0.match_raw) <@ sports_hub_tokens(split_part(c0.summary, '⟩'::text, 1)) AS loose,
            sports_hub_tokens(c0.full_raw) <@ sports_hub_tokens(split_part(c0.summary, '⟩'::text, 1)) AS strict
           FROM cand0 c0
          WHERE c0.summary !~~ '*%'::text AND split_part(c0.summary, '•'::text, 1) !~* '(school photo|makeup|make-up|retake|^\s*check on)'::text AND c0.type_part !~* '(school photo|makeup|make-up|retake|^\s*check on)'::text AND cardinality(sports_hub_tokens(c0.org_raw)) > 0
        )
 SELECT gotphoto_job_id,
    name,
    btrim(regexp_replace(org_raw, '\s*(19|20)[0-9]{2}(\s*-\s*[0-9]{2,4})?\s*$'::text, ''::text)) AS org,
    picture_day,
    status,
    access_type,
    job_type,
    workflow,
    workflow_reason,
    gp_activated_at,
    hub_dates,
    ( SELECT COALESCE(jsonb_agg(jsonb_build_object('event_id', c.google_event_id, 'date', c.start_date, 'end_date', c.end_date, 'all_day', c.all_day, 'start_at', c.start_at, 'end_at', c.end_at, 'label', c.type_part, 'summary', btrim(split_part(c.summary, '⟩'::text, 1))) ORDER BY c.start_date, c.start_at), '[]'::jsonb) AS "coalesce"
           FROM cand c
          WHERE c.gotphoto_job_id = jobs.gotphoto_job_id AND c.loose AND (c.strict OR NOT (EXISTS ( SELECT 1
                   FROM cand s
                  WHERE s.gotphoto_job_id = jobs.gotphoto_job_id AND s.strict)))) AS calendar_dates,
    code_count,
    roster_loaded_at
   FROM win jobs
  ORDER BY picture_day, name;
