# Compliance collection decisions and process-default rollout

This first change disables scheduled process snapshots by default in the agent
and the web app's generated configuration. It does not implement the remaining
recommendations below. These are product decisions based on purpose and minimum
evidence, not a claim that an endpoint agent proves ISO 27001 or NIST compliance.

## Collector decision table

| Collector / evidence | Recommended approach | This change |
|---|---|---|
| Device identity / OS | Keep minimum identifiers and OS/build needed for inventory and policy evaluation | Unchanged |
| Installed software | Keep name, publisher and version; later prefer changes over repeated full lists | Unchanged |
| Patch status | Keep update state and freshness; assess reboot evidence separately | Unchanged |
| Security posture | Keep AV, firewall and encryption state; represent errors and unsupported checks explicitly | Unchanged |
| Agent health / timestamps | Keep provenance, freshness and errors | Unchanged |
| CPU/RAM/disk usage | Operational feature; reduce cadence or make optional rather than treating it as compliance evidence | Unchanged |
| Process snapshots including command details | Optional investigation only; default off | Default off in agent and generated template |
| System/application logs and security events | Review event allowlists, free-text exposure and retention; retain selected detections where justified | Unchanged |
| Scheduled YARA scans | Recommend explicit investigation enablement after reviewing paths and exposed filenames | Unchanged; currently default on |
| Connected peripherals / Wi-Fi | Review each field against asset policy; remove personal network identifiers unless justified | Unchanged |
| Software risk heuristics | Review accuracy and whether existing inventory can support server-side evaluation | Unchanged |
| Gateway SNMP / syslog / discovery / Zeek | Separate network-monitoring purpose and configuration | Unchanged |

## Existing installations

Configuration precedence remains defaults, then saved file, then environment.
Missing `collectProcesses` now resolves to false. Saved true remains true: the
agent cannot distinguish an old automatically saved default from an intentional
administrator choice, so no automatic rewrite is applied.

1. Set `collectProcesses: false` in the deployed `config.json`.
2. Check the service environment: `NOVARIS_COLLECT_PROCESSES=true` overrides the file.
   Set it to false or remove it as appropriate.
3. Restart the agent so existing collection timers and in-memory queues end.
4. Confirm the log says `Process collection disabled (collectProcesses=false)`
   and that no new process reports arrive from that device after restart.

Downloading the new template does not update existing installations. Do not copy
an entire template over a working configuration; change the selected setting.
No backend schema/API change or deletion of historical records is included.
Choose historical process retention/deletion separately before a fleet rollout.

## Dependencies and practical limits

- `src/services/agentService.ts`, `startProcessReporting`, already checks the flag
  before its immediate report and interval. `reportProcesses` sends snapshots via
  `src/services/reportingService.ts` to `/devices/:deviceId/processes`.
- `src/services/processRegistryService.ts` registers this job using the same flag.
- Backend `src/services/DeviceProcessLogService.ts` stores/retrieves snapshots.
  Web `src/components/device_process_monitoring.tsx` displays them. With collection
  off, this view may contain historical data rather than a current snapshot.
- `src/rules/sigma/suspicious-process-start.yml` matches log message text, not
  this periodic process payload. Disabling snapshots does not disable that log rule;
  its coverage still depends on available source logs and event settings.
- Any external/custom rules consuming the process API need an operator review.
  Disabled or stale process evidence must not be interpreted as a passing check.
- The existing Running processes setting can re-enable periodic snapshots at
  `processInterval` (currently 60 seconds). It has no automatic expiry and still
  sends `command`; enable only for a defined investigation and disable afterward.
  A dedicated one-shot, command-free diagnostic capture is future work.
- This setting is not a global guarantee against process information appearing
  in other logs or explicit response actions. Those paths need separate review.

## Next review

Review command-field removal, selected log events, scheduled YARA, personal network
identifiers and retention using the existing endpoint-compliance audit as input.
Validate its findings against current code before implementing broader changes.
