-- FOOT26 : quotas indépendants pour les tentatives d'authentification.
-- Migration additive : ne supprime ni ne modifie les comptes, équipes, matchs ou événements.
create table if not exists public.auth_rate_limits (
  id bigserial primary key,
  key_type text not null check (key_type in ('ip', 'email')),
  key_hash text not null,
  attempted_at timestamptz not null default now()
);
create index if not exists auth_rate_limits_lookup_idx
  on public.auth_rate_limits (key_type, key_hash, attempted_at desc);
create index if not exists auth_rate_limits_attempted_at_idx
  on public.auth_rate_limits (attempted_at);
alter table public.auth_rate_limits enable row level security;

create or replace function public.consume_auth_rate_limit(
  p_key_type text,
  p_key_hash text,
  p_max_attempts integer,
  p_window_seconds integer
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  attempt_count integer;
begin
  if p_key_type not in ('ip', 'email') or p_max_attempts < 1 or p_window_seconds < 1
     or length(p_key_hash) <> 64 then
    raise exception 'Invalid rate-limit arguments';
  end if;

  -- Sérialise les requêtes portant sur la même clé, sans mélanger IP et e-mail.
  perform pg_advisory_xact_lock(hashtext(p_key_type), hashtext(p_key_hash));
  -- Purge globale pour éviter que les empreintes qui ne reviennent jamais s'accumulent.
  delete from public.auth_rate_limits where attempted_at < now() - interval '1 day';

  select count(*) into attempt_count
    from public.auth_rate_limits
   where key_type = p_key_type and key_hash = p_key_hash
     and attempted_at >= now() - make_interval(secs => p_window_seconds);

  if attempt_count >= p_max_attempts then
    return false;
  end if;

  insert into public.auth_rate_limits(key_type, key_hash) values (p_key_type, p_key_hash);
  return true;
end;
$$;

revoke all on function public.consume_auth_rate_limit(text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.consume_auth_rate_limit(text, text, integer, integer) to service_role;
