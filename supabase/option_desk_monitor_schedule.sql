-- Run after option_desk_push.sql and after adding option_desk_monitor_token to Vault.
-- Two-minute spacing prevents a slow market-data scan from overlapping the next run.
-- The job reads its token from Vault at execution time; no secret is committed.
select cron.schedule(
  'option-desk-monitor-every-minute',
  '*/2 * * * *',
  $job$
    select net.http_post(
      url := 'https://zzynqlqnzdhkffvqvpzt.supabase.co/functions/v1/option-desk-monitor',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-monitor-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'option_desk_monitor_token')
      ),
      body := '{"action":"scan"}'::jsonb,
      timeout_milliseconds := 45000
    );
  $job$
);
