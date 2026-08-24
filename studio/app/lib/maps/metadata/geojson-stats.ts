/** Parking-like polygons and turn-related features from RoadRunner GeoJSON exports. */
export function extractGeojsonDerivedStats(geojsonText: string): {
  parking_space_count: number;
  turn_straight: number;
  turn_left: number;
  turn_right: number;
  turn_uturn_left: number;
  turn_uturn_right: number;
  warnings: string[];
} {
  const warnings: string[] = [];
  let root: unknown;
  try {
    root = JSON.parse(geojsonText) as unknown;
  } catch {
    warnings.push("geojson: invalid JSON");
    return {
      parking_space_count: 0,
      turn_straight: 0,
      turn_left: 0,
      turn_right: 0,
      turn_uturn_left: 0,
      turn_uturn_right: 0,
      warnings,
    };
  }

  let parking_space_count = 0;
  let turn_straight = 0;
  let turn_left = 0;
  let turn_right = 0;
  let turn_uturn_left = 0;
  let turn_uturn_right = 0;

  function visitFeature(feature: Record<string, unknown>) {
    const geom = feature.geometry as Record<string, unknown> | null | undefined;
    const props = (feature.properties ?? {}) as Record<string, unknown>;
    const geomType = String(geom?.type ?? "");

    // RoadRunner uses PascalCase "Type" with the exact value "ParkingSpace".
    const type = String(props.Type ?? props.type ?? "");

    if (type === "ParkingSpace" && (geomType === "Polygon" || geomType === "MultiPolygon")) {
      parking_space_count += 1;
    }

    // RoadRunner stores turn data in the "TurnRelation" property on Gate features.
    // Full set of observed values: Straight, Left, Right, UTurnLeft, UTurnRight.
    if (type === "Gate") {
      const turn = String(props.TurnRelation ?? "");
      switch (turn) {
        case "Straight":    turn_straight += 1;    break;
        case "Left":        turn_left += 1;         break;
        case "Right":       turn_right += 1;        break;
        case "UTurnLeft":   turn_uturn_left += 1;   break;
        case "UTurnRight":  turn_uturn_right += 1;  break;
        default:
          if (turn) {
            warnings.push(
              `geojson: unrecognised TurnRelation value "${turn}" on Gate ${String(props.Id ?? "")}`,
            );
          }
      }
    }
  }

  function walk(obj: unknown) {
    if (!obj || typeof obj !== "object") return;
    const o = obj as Record<string, unknown>;
    if (o.type === "Feature") {
      visitFeature(o);
      return;
    }
    if (o.type === "FeatureCollection" && Array.isArray(o.features)) {
      for (const f of o.features) walk(f);
    }
  }

  walk(root);

  return {
    parking_space_count,
    turn_straight,
    turn_left,
    turn_right,
    turn_uturn_left,
    turn_uturn_right,
    warnings,
  };
}
