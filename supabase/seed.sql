-- G0 capability matrix starting rows (spec §4). Every row starts as 'untested';
-- the G0 spike scripts update status, version, sample I/O and verified_at.
insert into public.tool_capabilities (tool_name, operation, deployment_mode, notes) values
  ('kicad',     'headless_erc',          'docker worker', 'kicad-cli sch erc'),
  ('kicad',     'headless_drc',          'docker worker', 'kicad-cli pcb drc'),
  ('kicad',     'schematic_generation',  'docker worker', 'IPC API vs direct S-expression vs atopile/SKiDL'),
  ('kicad',     'pcb_generation',        'docker worker', 'IPC API needs a running instance; verify headless options'),
  ('kicad',     'fab_outputs',           'docker worker', 'Gerber, drill, position, BOM'),
  ('kicad',     'step_export',           'docker worker', 'Board + component 3D STEP'),
  ('kicad',     'ipc_api',               'docker worker', 'kicad-python IPC API (needs a running KiCad instance)'),
  ('kikit',     'panelization',          'docker worker', null),
  ('freerouting','autoroute',            'docker worker', 'DSN/SES round trip; quality on 2-4 layer boards'),
  ('ngspice',   'transient_simulation',  'docker worker', 'Reference circuit with saved waveforms'),
  ('cadquery',  'step_import_export',    'docker worker', 'OCCT-based; manufacturer STEP round trip'),
  ('cadquery',  'interference_check',    'docker worker', 'Board STEP vs enclosure collision'),
  ('cadquery',  'enclosure_generation',  'docker worker', 'Parametric housing from board outline'),
  ('atopile',   'netlist_compile',       'docker worker', 'Code-to-KiCad circuit description'),
  ('skidl',     'netlist_compile',       'docker worker', 'Python circuit description to KiCad netlist'),
  ('digikey',   'product_search',        'hosted API',    'API v4; register for developer credentials'),
  ('mouser',    'product_search',        'hosted API',    null),
  ('nexar',     'part_lookup',           'hosted API',    'Octopart data; check quota tiers and caching terms'),
  ('lcsc_jlc',  'parts_catalog',         'download',      'Basic vs extended parts for JLC assembly'),
  ('kicanvas',  'browser_view',          'browser',       'Schematic/PCB viewer for KiCad files'),
  ('threejs',   'step_render',           'browser',       'occt-import-js or server-side STEP to glTF'),
  ('flux',      'project_export',        'manual',        'Confirm what the account can export')
on conflict (tool_name, operation) do nothing;
