export type StoredSimulationArtifact = {
  id: string;
  workspace_id: string;
  scenario_id: string | null;
  simulation_id: string | null;
  kind: string;
  label: string | null;
  content_type: string | null;
  file_ext: string | null;
  size_bytes: number | null;
  checksum_sha256: string | null;
  s3_bucket: string;
  s3_key: string;
  artifact_class: string | null;
  sensor_id: string | null;
  sensor_label: string | null;
  sensor_category: string | null;
  output_modality: string | null;
  artifact_format: string | null;
  frame_index: number | null;
  sequence_id: string | null;
  is_raw: boolean;
  metadata_json: string | null;
  created_by_user_id: string | null;
  created_at: string;
};

