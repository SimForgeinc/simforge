import { Input } from "@/app/components/ui/input";
import { FieldLabel } from "./FieldLabel";

interface LocationOverrideFieldsProps {
  city: string;
  state: string;
  country: string;
  onCityChange: (v: string) => void;
  onStateChange: (v: string) => void;
  onCountryChange: (v: string) => void;
}

/** City / State / Country 3-column grid for optional location override. */
export function LocationOverrideFields({
  city, state, country,
  onCityChange, onStateChange, onCountryChange,
}: LocationOverrideFieldsProps) {
  return (
    <div>
      <FieldLabel>Location</FieldLabel>
      <p className="mb-2 text-xs text-muted-foreground">
        Optional. Auto-filled from map coordinates. Override if the nearest city is incorrect.
      </p>
      <div className="grid grid-cols-3 gap-2">
        <div>
          <label className="mb-1 block text-[11px] text-muted-foreground">City</label>
          <Input
            value={city}
            onChange={(e) => onCityChange(e.target.value)}
            placeholder="e.g. San Jose"
            className="h-8 text-xs"
          />
        </div>
        <div>
          <label className="mb-1 block text-[11px] text-muted-foreground">State / Region</label>
          <Input
            value={state}
            onChange={(e) => onStateChange(e.target.value)}
            placeholder="e.g. California"
            className="h-8 text-xs"
          />
        </div>
        <div>
          <label className="mb-1 block text-[11px] text-muted-foreground">Country</label>
          <Input
            value={country}
            onChange={(e) => onCountryChange(e.target.value)}
            placeholder="e.g. United States"
            className="h-8 text-xs"
          />
        </div>
      </div>
    </div>
  );
}
