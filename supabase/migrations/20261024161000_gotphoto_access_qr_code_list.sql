-- GotPhoto's "QR-Tagging - with list of names" is password_source qr_code_list (read back from real jobs on
-- 2026-10-23; GotPhoto's API docs only list manual, qr_code, file_path and registration). The first default saved
-- as file_path, which GotPhoto shows as a different method.
alter table public.gp_type_defaults drop constraint if exists gp_type_defaults_password_source_check;
alter table public.gp_type_defaults add constraint gp_type_defaults_password_source_check
  check (password_source in ('manual', 'qr_code', 'qr_code_list', 'file_path', 'registration'));
update public.gp_type_defaults set password_source = 'qr_code_list' where password_source = 'file_path';
