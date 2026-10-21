// Referee setup (tools/referee-setup.sh): rewrites the operator's Unity engine assemblies for headless CoreCLR. Unity
// InternalCalls cannot even be JIT-compiled without the native engine, so every InternalCall / native extern method gets a
// managed body that reports the hit (UnityEngine.L3Stub.OnHit, injected into CoreModule) and returns default.
// Usage: Stubber <Managed dir> <out dir>. Reads UnityEngine*.dll, writes only to <out dir> (never commit the output).
using System; using System.IO; using System.Linq;
using Mono.Cecil; using Mono.Cecil.Cil;
static class Stubber {
  static int Main(string[] a) {
    string inDir = a[0], outDir = a[1]; Directory.CreateDirectory(outDir);
    var res = new DefaultAssemblyResolver(); res.AddSearchDirectory(outDir); res.AddSearchDirectory(inDir);
    // CoreModule first (hosts L3Stub)
    var files = Directory.GetFiles(inDir, "UnityEngine*.dll").OrderBy(f => Path.GetFileName(f) == "UnityEngine.CoreModule.dll" ? 0 : 1).ToList();
    FieldReference hookCore = null;
    foreach (var f in files) {
      var asm = AssemblyDefinition.ReadAssembly(f, new ReaderParameters { AssemblyResolver = res });
      var mod = asm.MainModule;
      FieldReference hook;
      if (Path.GetFileName(f) == "UnityEngine.CoreModule.dll") {
        var t = new TypeDefinition("UnityEngine", "L3Stub", TypeAttributes.Public | TypeAttributes.Abstract | TypeAttributes.Sealed | TypeAttributes.Class, mod.TypeSystem.Object);
        var fd = new FieldDefinition("OnHit", FieldAttributes.Public | FieldAttributes.Static, mod.ImportReference(typeof(Action<string>)));
        t.Fields.Add(fd); mod.Types.Add(t); hook = fd; hookCore = fd;
      } else {
        if (hookCore == null) throw new Exception("core first");
        hook = mod.ImportReference(hookCore);
      }
      var invoke = mod.ImportReference(typeof(Action<string>).GetMethod("Invoke"));
      var nse = mod.ImportReference(typeof(NotSupportedException).GetConstructor(new[] { typeof(string) }));
      int n = 0;
      foreach (var type in mod.GetTypes()) foreach (var m in type.Methods) {
        bool icall = m.ImplAttributes.HasFlag(MethodImplAttributes.InternalCall);
        bool pinv = m.IsPInvokeImpl;
        if (!icall && !pinv) continue;
        if (pinv) { m.IsPInvokeImpl = false; m.PInvokeInfo = null; }
        m.ImplAttributes &= ~(MethodImplAttributes.InternalCall);
        m.ImplAttributes = (m.ImplAttributes & ~MethodImplAttributes.CodeTypeMask) | MethodImplAttributes.IL;
        m.IsRuntime = false; m.IsInternalCall = false;
        var body = new MethodBody(m); m.Body = body; var il = body.GetILProcessor();
        string name = type.FullName + "::" + m.Name;
        var skip = il.Create(OpCodes.Nop);
        il.Emit(OpCodes.Ldsfld, hook); il.Emit(OpCodes.Dup); var call = il.Create(OpCodes.Ldstr, name);
        il.Emit(OpCodes.Brtrue_S, call); il.Emit(OpCodes.Pop); il.Emit(OpCodes.Br_S, skip);
        il.Append(call); il.Emit(OpCodes.Callvirt, invoke); il.Append(skip);
        var rt = m.ReturnType;
        if (rt.MetadataType == MetadataType.Void) il.Emit(OpCodes.Ret);
        else if (rt.IsByReference) { il.Emit(OpCodes.Ldstr, "L3 stub byref " + name); il.Emit(OpCodes.Newobj, nse); il.Emit(OpCodes.Throw); }
        else if (rt.IsValueType || rt.IsGenericParameter || rt.IsPointer || rt.IsFunctionPointer) {
          var v = new VariableDefinition(rt); body.Variables.Add(v); body.InitLocals = true; il.Emit(OpCodes.Ldloc, v); il.Emit(OpCodes.Ret);
        } else { il.Emit(OpCodes.Ldnull); il.Emit(OpCodes.Ret); }
        n++;
      }
      asm.Write(Path.Combine(outDir, Path.GetFileName(f)));
      Console.WriteLine($"{Path.GetFileName(f)}: {n} stubbed");
    }
    return 0;
  }
}
