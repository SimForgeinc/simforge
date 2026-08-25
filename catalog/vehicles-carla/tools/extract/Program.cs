using CUE4Parse;
using CUE4Parse.FileProvider;
using CUE4Parse.UE4.Assets;
using CUE4Parse.UE4.Assets.Exports;
using CUE4Parse.UE4.Assets.Exports.Material;
using CUE4Parse.UE4.Assets.Exports.SkeletalMesh;
using CUE4Parse.UE4.Assets.Exports.StaticMesh;
using CUE4Parse.UE4.Versions;
using CUE4Parse_Conversion;
using CUE4Parse_Conversion.Options;
using Newtonsoft.Json;
using Serilog;

namespace SimforgeCarlaExport;

public static class Program
{
    public static async Task<int> Main(string[] args)
    {
        Log.Logger = new LoggerConfiguration().WriteTo.Console().MinimumLevel.Information().CreateLogger();
        CUE4ParseLog.UseLogger(Log.Logger);

        if (args.Length > 2 && args[2] == "--sections") { SectionProbe.Run(args[0], args[1]); return 0; }
        if (args.Length > 3 && args[2] == "--dumpbp") { SectionProbe.DumpBp(args[0], args[1], args[3]); return 0; }
        if (args.Length > 3 && args[2] == "--dumpbps") { SectionProbe.DumpBps(args[0], args[1], args[3]); return 0; }
        var contentDir = args[0]; // dir containing CarlaUnreal/Content/...
        var outDir = args[1];
        var targetsFile = args[2]; // newline-separated mesh object names (SK_*/SM_*)
        var probeOnly = args.Length > 3 && args[3] == "--probe";

        var targets = new HashSet<string>(
            File.ReadAllLines(targetsFile).Select(l => l.Trim()).Where(l => l.Length > 0),
            StringComparer.OrdinalIgnoreCase);

        var provider = new DefaultFileProvider(contentDir, SearchOption.AllDirectories,
            new VersionContainer(EGame.GAME_UE5_5));
        provider.Initialize();
        provider.PostMount();
        Log.Information("provider mounted: {Count} files", provider.Files.Count);

        var session = new ExportSession();
        var sidecar = new Dictionary<string, object>();
        var found = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        foreach (var file in provider.Files.Values)
        {
            if (!file.Extension.Equals("uasset", StringComparison.OrdinalIgnoreCase)) continue;
            if (!targets.Contains(file.NameWithoutExtension)) continue;
            if (found.Contains(file.NameWithoutExtension)) continue;

            Log.Information("loading {Path}", file.Path);
            IPackage pkg;
            try { pkg = provider.LoadPackage(file); }
            catch (Exception e) { Log.Error(e, "failed to load {Path}", file.Path); continue; }

            foreach (var export in pkg.GetExports())
            {
                if (export is not (USkeletalMesh or UStaticMesh)) continue;
                found.Add(file.NameWithoutExtension);

                var slots = new List<object>();
                var materials = new Dictionary<string, object>();

                void AddMaterialObj(UMaterialInterface mat)
                {
                    if (mat == null) return;
                    var key = mat.GetPathName();
                    if (materials.ContainsKey(key)) return;
                    try
                    {
                        materials[key] = JsonConvert.DeserializeObject(JsonConvert.SerializeObject(mat));
                    }
                    catch (Exception e)
                    {
                        Log.Warning("material json failed for {Key}: {Msg}", key, e.Message);
                        materials[key] = new { error = e.Message };
                    }
                    if (!probeOnly)
                    {
                        try { session.Add(mat); }
                        catch (Exception e) { Log.Warning("enqueue material failed for {Key}: {Msg}", key, e.Message); }
                    }
                    if (mat is UMaterialInstance mi && mi.Parent is UMaterialInterface parent)
                        AddMaterialObj(parent);
                }

                void AddMaterialIndex(CUE4Parse.UE4.Objects.UObject.FPackageIndex idx)
                {
                    if (idx == null || idx.IsNull) return;
                    if (idx.TryLoad(out var matObj) && matObj is UMaterialInterface mat)
                        AddMaterialObj(mat);
                }

                if (export is USkeletalMesh sk)
                {
                    foreach (var m in sk.SkeletalMaterials ?? [])
                    {
                        slots.Add(new
                        {
                            slot = m.MaterialSlotName.Text,
                            material = m.Material?.ResolvedObject?.GetPathName(),
                        });
                        AddMaterialIndex(m.Material);
                    }
                }
                else if (export is UStaticMesh sm)
                {
                    foreach (var m in sm.StaticMaterials ?? [])
                    {
                        slots.Add(new
                        {
                            slot = m.MaterialSlotName.Text,
                            material = m.MaterialInterface?.ResolvedObject?.GetPathName(),
                        });
                        AddMaterialIndex(m.MaterialInterface);
                    }
                }

                sidecar[export.Name] = new
                {
                    package = file.Path,
                    @class = export.ExportType,
                    slots,
                    materials,
                };

                if (!probeOnly) session.Add(export);
                Log.Information("queued {Name} ({Class}) slots={Slots}", export.Name, export.ExportType, slots.Count);
            }
        }

        foreach (var t in targets.Except(found)) Log.Warning("target NOT FOUND: {Target}", t);

        Directory.CreateDirectory(outDir);
        File.WriteAllText(Path.Combine(outDir, "materials-sidecar.json"),
            JsonConvert.SerializeObject(sidecar, Formatting.Indented));
        Log.Information("sidecar written with {Count} meshes", sidecar.Count);
        if (probeOnly) return 0;

        var options = new ExportOptions(
            meshFormat: EMeshFormat.Gltf2,
            textureFormat: ETextureFormat.Png,
            materialDepth: EMaterialDepth.AllLayers,
            exportMaterials: true,
            exportMorphTargets: false);

        var results = await session.RunAsync(outDir, options);
        var ok = 0; var fail = 0;
        foreach (var r in results)
        {
            if (r.Success) ok++;
            else { fail++; Log.Warning("export failed: {Path}", r.ObjectPath); }
        }
        Log.Information("done: {Ok} ok, {Fail} failed", ok, fail);
        return 0;
    }
}
