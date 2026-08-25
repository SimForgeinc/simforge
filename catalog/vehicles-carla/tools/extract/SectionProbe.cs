using CUE4Parse;
using CUE4Parse.FileProvider;
using CUE4Parse.UE4.Assets.Exports.SkeletalMesh;
using CUE4Parse.UE4.Versions;
using Serilog;

namespace SimforgeCarlaExport;

public static class SectionProbe
{

    public static void DumpBp(string contentDir, string bpName, string outFile)
    {
        var provider = new DefaultFileProvider(contentDir, SearchOption.AllDirectories,
            new VersionContainer(EGame.GAME_UE5_5));
        provider.Initialize();
        provider.PostMount();
        foreach (var file in provider.Files.Values)
        {
            if (!file.Extension.Equals("uasset", StringComparison.OrdinalIgnoreCase)) continue;
            if (!file.NameWithoutExtension.Equals(bpName, StringComparison.OrdinalIgnoreCase)) continue;
            var pkg = provider.LoadPackage(file);
            var json = Newtonsoft.Json.JsonConvert.SerializeObject(pkg.GetExports(), Newtonsoft.Json.Formatting.Indented);
            File.WriteAllText(outFile, json);
            Console.WriteLine($"dumped {file.Path} -> {outFile} ({json.Length} chars)");
            return;
        }
        Console.WriteLine("bp not found");
    }

    public static void Run(string contentDir, string meshName)
    {
        var provider = new DefaultFileProvider(contentDir, SearchOption.AllDirectories,
            new VersionContainer(EGame.GAME_UE5_5));
        provider.Initialize();
        provider.PostMount();

        foreach (var file in provider.Files.Values)
        {
            if (!file.Extension.Equals("uasset", StringComparison.OrdinalIgnoreCase)) continue;
            if (!file.NameWithoutExtension.Equals(meshName, StringComparison.OrdinalIgnoreCase)) continue;
            var pkg = provider.LoadPackage(file);
            foreach (var export in pkg.GetExports())
            {
                if (export is not USkeletalMesh sk) continue;
                Console.WriteLine($"mesh {sk.Name}");
                for (var i = 0; i < sk.SkeletalMaterials.Length; i++)
                {
                    var m = sk.SkeletalMaterials[i];
                    Console.WriteLine($"  slot[{i}] {m.MaterialSlotName} imported={m.ImportedMaterialSlotName} mat={m.Material?.Name}");
                }
                if (sk.LODModels != null)
                {
                    for (var l = 0; l < sk.LODModels.Length; l++)
                    {
                        var lod = sk.LODModels[l];
                        Console.WriteLine($"  LOD{l}: {lod.Sections.Length} sections");
                        foreach (var s in lod.Sections)
                        {
                            Console.WriteLine($"    section mat={s.MaterialIndex} tris={s.NumTriangles} baseIndex={s.BaseIndex} disabled={s.bDisabled}");
                        }
                    }
                }
            }
            return;
        }
        Console.WriteLine("mesh not found");
    }
}
