-- Part files may be 3D models (STEP), kept apart from datasheets and drawings.
alter table public.project_references drop constraint project_references_kind_check;
alter table public.project_references add constraint project_references_kind_check
  check (kind in ('mockup', 'sketch', 'render', 'photo', 'drawing', 'prior_design', 'datasheet', 'model_3d', 'other'));
