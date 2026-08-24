//! `native-render-job` — execute one batch render job file.
//!
//! Usage: native-render-job --job <job.json>
//! Writes artifacts into the job's out_dir plus results.json; prints the
//! timings summary as JSON on stdout.
use anyhow::{Context, Result};
use render_core::job::{run_job, RenderJob};

fn main() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let mut job_path = None;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--job" => {
                job_path = Some(args.next().context("--job requires a path")?);
            }
            other => anyhow::bail!("unknown argument {other}; usage: native-render-job --job <job.json>"),
        }
    }
    let job_path = job_path.context("missing required --job <job.json>")?;
    let job: RenderJob =
        serde_json::from_str(&std::fs::read_to_string(&job_path).with_context(|| format!("read {job_path}"))?)
            .with_context(|| format!("parse {job_path}"))?;
    let results = run_job(&job)?;
    println!("{}", serde_json::to_string(&results.timings)?);
    Ok(())
}
