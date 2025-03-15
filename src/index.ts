import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import * as url from "node:url";

import * as Plot from "@observablehq/plot";
import * as d3 from "d3";
import { JSDOM } from "jsdom";
import * as _ from "lodash-es";
import sharp from "sharp";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));

interface Datum {
  programId: string;
  playwrightWorkflowId: string;
  duration: number;
}

/**
 * Load the recorded performance metrics for Study 1.
 *
 * @returns – An object containing the performance metrics for each of the four
 * measurement conditions of Study 1: forward evaluation (fe), reconciliation
 * (recon), forward evaluation time-to-quiescent (fe-ttq), and reconciliation
 * time-to-quiescent (recon-ttq).
 */
async function loadInputData(): Promise<{
  study1Fe: Datum[];
  study1Recon: Datum[];
  study1FeTTQ: Datum[];
  study1ReconTTQ: Datum[];
}> {
  const directory = path.resolve(__dirname, "../input");
  const files = ["fe.json", "recon.json", "fe-ttq.json", "recon-ttq.json"];

  try {
    const [study1Fe, study1Recon, study1FeTTQ, study1ReconTTQ] =
      await Promise.all(
        files.map((file) =>
          fsPromises.readFile(path.resolve(directory, file), "utf-8")
        )
      ).then((data) => data.map((d) => JSON.parse(d) as Datum[]));

    return {
      study1Fe,
      study1Recon,
      study1FeTTQ,
      study1ReconTTQ,
    };
  } catch (error) {
    console.error("Error loading files:", error);
  }
}

interface MedianRuntime {
  workflow: string;
  program: string;
  duration: number;
  workflowId: number;
  programId: number;
}

/**
 * Derive the median runtime for each program and workflow (interaction pair) in
 * the dataset.
 *
 * @param arr – An array of performance metrics for a given measurement
 * condition.
 * @returns – An array of objects containing the median runtime for each program
 * and workflow in the dataset.
 */
function deriveMedianRuntime(arr: Datum[]): MedianRuntime[] {
  const ipPairs = _.groupBy(
    arr,
    (d) => `${d.playwrightWorkflowId}__${d.programId}`
  );

  const ipMedians = _.mapValues(ipPairs, (entries) =>
    d3.median(entries, (d) => d.duration)
  );

  const medians = Object.entries(ipMedians).map(([key, value]) => {
    const workflow = key.substring(0, key.indexOf("_"));
    const program = key.substring(key.lastIndexOf("_") + 1, key.length);
    const workflowId = +workflow.substring(
      workflow.indexOf("-") + 1,
      workflow.length
    );
    const programId = +program.substring(
      program.indexOf("-") + 1,
      program.length
    );

    return {
      workflow,
      program,
      duration: value,
      workflowId,
      programId,
    };
  });

  return _.sortBy(medians, ["workflowId", "programId"]);
}

interface PairwiseDatum {
  fe: number;
  recon: number;
  x1: number;
  x2: number;
  y1: number;
  y2: number;
}

/**
 * Generate pairwise comparisons between the median runtimes of forward
 * evaluation and reconciliation for each program and workflow in the dataset.
 *
 * @param feMedians – The array of median runtimes for forward evaluation.
 * @param feTraces – The array of all forward evaluation traces.
 * @param reconMedians – The array of median runtimes for reconciliation.
 * @param reconTraces – The array of all reconciliation traces.
 * @returns – An array of pairwise comparisons between forward evaluation and
 * reconciliation runtimes.
 */
function generatePairwiseComparisons(
  feMedians: MedianRuntime[],
  feTraces: Datum[],
  reconMedians: MedianRuntime[],
  reconTraces: Datum[]
): PairwiseDatum[] {
  return feMedians.map((feMedian) => {
    const reconMedian = reconMedians.find(
      (med) =>
        med.program === feMedian.program && med.workflow === feMedian.workflow
    );
    const feRecords = feTraces.filter((trace) => {
      return (
        trace.playwrightWorkflowId === feMedian.workflow &&
        trace.programId === feMedian.program
      );
    });
    const reconRecords = reconTraces.filter((trace) => {
      return (
        trace.playwrightWorkflowId === feMedian.workflow &&
        trace.programId === feMedian.program
      );
    });

    const x1 =
      feMedian.duration -
      d3.deviation(feRecords, (d) => d.duration) / Math.sqrt(feRecords.length);
    const x2 =
      feMedian.duration +
      d3.deviation(feRecords, (d) => d.duration) / Math.sqrt(feRecords.length);
    const y1 =
      reconMedian.duration -
      d3.deviation(reconRecords, (d) => d.duration) /
        Math.sqrt(reconRecords.length);
    const y2 =
      reconMedian.duration +
      d3.deviation(reconRecords, (d) => d.duration) /
        Math.sqrt(reconRecords.length);

    return {
      fe: feMedian.duration,
      recon: reconMedian.duration,
      x1,
      x2,
      y1,
      y2,
    };
  });
}

interface SpeedupDatum {
  fe: number;
  speedup: number;
  x1: number;
  x2: number;
}

/**
 * Generate the speedup factor from reconciliation for each program and workflow
 * in the dataset.
 *
 * @param feTTQMedians – The median runtimes for forward evaluation time-to-
 * quiescent.
 * @param feTTQTraces – The array of all forward evaluation time-to-quiescent
 * traces.
 * @param reconTTQMedians – The median runtimes for reconciliation time-to-
 * quiescent.
 * @returns – An array of speedup factors for each program and workflow.
 */
function generateSpeedups(
  feTTQMedians: MedianRuntime[],
  feTTQTraces: Datum[],
  reconTTQMedians: MedianRuntime[]
): SpeedupDatum[] {
  return feTTQMedians.map((feTTQMedian) => {
    const reconMedian = reconTTQMedians.find(
      (med) =>
        med.program === feTTQMedian.program &&
        med.workflow === feTTQMedian.workflow
    );

    const feRecords = feTTQTraces.filter((trace) => {
      return (
        trace.playwrightWorkflowId === feTTQMedian.workflow &&
        trace.programId === feTTQMedian.program
      );
    });

    const x1 =
      feTTQMedian.duration -
      d3.deviation(feRecords, (d) => d.duration) / Math.sqrt(feRecords.length);
    const x2 =
      feTTQMedian.duration +
      d3.deviation(feRecords, (d) => d.duration) / Math.sqrt(feRecords.length);

    const speedup = feTTQMedian.duration / reconMedian.duration;
    return {
      fe: feTTQMedian.duration,
      speedup,
      x1,
      x2,
    };
  });
}

interface CETTQDatum {
  ttq: number;
  ce: number;
  x1: number;
  x2: number;
  y1: number;
  y2: number;
}

function generateReconCETTQ(
  reconTTQMedians: MedianRuntime[],
  reconTTQTraces: Datum[],
  reconMedians: MedianRuntime[],
  reconTraces: Datum[]
): CETTQDatum[] {
  return reconTTQMedians.map((reconIdleMed) => {
    const reconMed = reconMedians.find(
      (reconMed) =>
        reconMed.workflow === reconIdleMed.workflow &&
        reconMed.program === reconIdleMed.program
    );

    const reconIdleRecords = reconTTQTraces.filter((trace) => {
      return (
        trace.playwrightWorkflowId === reconIdleMed.workflow &&
        trace.programId === reconIdleMed.program
      );
    });

    const reconRecords = reconTraces.filter((trace) => {
      return (
        trace.playwrightWorkflowId === reconIdleMed.workflow &&
        trace.programId === reconIdleMed.program
      );
    });

    const y1 =
      reconIdleMed.duration -
      d3.deviation(reconIdleRecords, (d) => d.duration) /
        Math.sqrt(reconIdleRecords.length);
    const y2 =
      reconIdleMed.duration +
      d3.deviation(reconIdleRecords, (d) => d.duration) /
        Math.sqrt(reconIdleRecords.length);
    const x1 =
      reconMed.duration -
      d3.deviation(reconRecords, (d) => d.duration) /
        Math.sqrt(reconRecords.length);
    const x2 =
      reconMed.duration +
      d3.deviation(reconRecords, (d) => d.duration) /
        Math.sqrt(reconRecords.length);

    return {
      ttq: reconIdleMed.duration,
      ce: reconMed.duration,
      x1,
      x2,
      y1,
      y2,
    };
  });
}

/**
 * Plot Figure 5 from the paper.
 *
 * @param data – An array of pairwise comparisons between forward evaluation
 * (TTQ) and reconciliation (TTQ) runtimes for each program and workflow.
 */
async function plotFigure5(data: PairwiseDatum[]): Promise<void> {
  const plot = Plot.plot({
    document: new JSDOM().window.document,
    grid: true,
    width: 640,
    height: 640,
    style: "font-size: 12px;",
    marginBottom: 40,
    x: { label: "Forward Evaluation TTQ (ms)", type: "log" },
    y: { label: "Reconciliation TTQ (ms)", type: "log" },
    marks: [
      Plot.dot(data, {
        x: "fe",
        y: "recon",
        fill: "#17807e",
        fillOpacity: 0.5,
      }),
      Plot.link(data, {
        x1: "x1",
        x2: "x2",
        y1: "recon",
        y2: "recon",
        stroke: "#17807e",
        strokeOpacity: 0.5,
        strokeDasharray: 1,
        strokeWidth: 1.5,
      }),
      Plot.link(data, {
        x1: "fe",
        x2: "fe",
        y1: "y1",
        y2: "y2",
        stroke: "#17807e",
        strokeOpacity: 0.5,
        strokeDasharray: 1,
        strokeWidth: 1.5,
      }),
      Plot.line(
        [
          [200, 200],
          [32000, 32000],
        ],
        { stroke: "#999999", strokeOpacity: 0.5, strokeDasharray: 2 }
      ),
    ],
  });

  plot.setAttributeNS(
    "http://www.w3.org/2000/xmlns/",
    "xmlns",
    "http://www.w3.org/2000/svg"
  );
  plot.setAttributeNS(
    "http://www.w3.org/2000/xmlns/",
    "xmlns:xlink",
    "http://www.w3.org/1999/xlink"
  );

  await sharp(Buffer.from(plot.outerHTML, "utf-8"))
    .flatten({ background: "#ffffff" })
    .toFile(path.resolve(__dirname, "../output/figure-5.png"));
}

/**
 * Plot Figure 6 from the paper.
 *
 * @param data – An array of pairwise comparisons between forward evaluation and
 * reconciliation runtimes for each program and workflow.
 */
async function plotFigure6(data: PairwiseDatum[]): Promise<void> {
  const plot = Plot.plot({
    document: new JSDOM().window.document,
    grid: true,
    width: 640,
    height: 640,
    style: "font-size: 12px;",
    marginBottom: 40,
    x: { label: "Forward Evaluation (ms)", type: "log", domain: [0.3, 240] },
    y: { label: "Reconciliation (ms)", type: "log", domain: [0.3, 240] },
    marks: [
      Plot.dot(data, {
        x: "fe",
        y: "recon",
        fill: "#17807e",
        fillOpacity: 0.5,
      }),
      Plot.link(data, {
        x1: "x1",
        x2: "x2",
        y1: "recon",
        y2: "recon",
        stroke: "#17807e",
        strokeOpacity: 0.5,
        strokeDasharray: 1,
        strokeWidth: 1.5,
      }),
      Plot.link(data, {
        x1: "fe",
        x2: "fe",
        y1: "y1",
        y2: "y2",
        stroke: "#17807e",
        strokeOpacity: 0.5,
        strokeDasharray: 1,
        strokeWidth: 1.5,
      }),
      Plot.line(
        [
          [0.3, 0.3],
          [240, 240],
        ],
        { stroke: "#999999", strokeOpacity: 0.5, strokeDasharray: 2 }
      ),
    ],
  });

  plot.setAttributeNS(
    "http://www.w3.org/2000/xmlns/",
    "xmlns",
    "http://www.w3.org/2000/svg"
  );
  plot.setAttributeNS(
    "http://www.w3.org/2000/xmlns/",
    "xmlns:xlink",
    "http://www.w3.org/1999/xlink"
  );

  await sharp(Buffer.from(plot.outerHTML, "utf-8"))
    .flatten({ background: "#ffffff" })
    .toFile(path.resolve(__dirname, "../output/figure-6.png"));
}

async function plotFigure7(data: SpeedupDatum[]): Promise<void> {
  const plot = Plot.plot({
    document: new JSDOM().window.document,
    x: {
      label: "Forward Evaluation (TTQ) (ms)",
      domain: [0, d3.max(data, (d) => d.fe)],
      range: [40, 620],
    },
    y: {
      label: "Speedup",
      domain: [0, d3.max(data, (d) => d.speedup)],
      range: [360, 20],
    },
    grid: true,
    style: "font-size: 12px;",
    marks: [
      Plot.dot(data, {
        x: "fe",
        y: "speedup",
        fill: "#801767",
        fillOpacity: 0.5,
      }),
      Plot.link(data, {
        x1: "x1",
        y1: "speedup",
        x2: "x2",
        y2: "speedup",
        stroke: "#801767",
        strokeOpacity: 0.5,
        strokeDasharray: 1,
        strokeWidth: 1.5,
      }),
    ],
  });

  plot.setAttributeNS(
    "http://www.w3.org/2000/xmlns/",
    "xmlns",
    "http://www.w3.org/2000/svg"
  );
  plot.setAttributeNS(
    "http://www.w3.org/2000/xmlns/",
    "xmlns:xlink",
    "http://www.w3.org/1999/xlink"
  );

  await sharp(Buffer.from(plot.outerHTML, "utf-8"))
    .flatten({ background: "#ffffff" })
    .toFile(path.resolve(__dirname, "../output/figure-7.png"));
}

async function plotFigure9(data: CETTQDatum[]): Promise<void> {
  const plot = Plot.plot({
    document: new JSDOM().window.document,
    x: { label: "Recon (ms)", type: "log" },
    y: { label: "Recon (TTQ) (ms)", type: "log" },
    style: "font-size: 13px;",
    grid: true,
    marks: [
      Plot.dot(data, {
        x: "ce",
        y: "ttq",
        fill: "#A35200",
        fillOpacity: 0.5,
      }),

      Plot.link(data, {
        x1: "x1",
        x2: "x2",
        y1: "ttq",
        y2: "ttq",
        stroke: "#A35200",
        strokeOpacity: 0.5,
        strokeDasharray: 1,
        strokeWidth: 1.5,
      }),
      Plot.link(data, {
        x1: "ce",
        x2: "ce",
        y1: "y1",
        y2: "y2",
        stroke: "#A35200",
        strokeOpacity: 0.5,
        strokeDasharray: 1,
        strokeWidth: 1.5,
      }),
    ],
  });

  plot.setAttributeNS(
    "http://www.w3.org/2000/xmlns/",
    "xmlns",
    "http://www.w3.org/2000/svg"
  );
  plot.setAttributeNS(
    "http://www.w3.org/2000/xmlns/",
    "xmlns:xlink",
    "http://www.w3.org/1999/xlink"
  );

  await sharp(Buffer.from(plot.outerHTML, "utf-8"))
    .flatten({ background: "#ffffff" })
    .toFile(path.resolve(__dirname, "../output/figure-9.png"));
}

async function main() {
  const { study1Fe, study1Recon, study1FeTTQ, study1ReconTTQ } =
    await loadInputData();

  const study1FeMedians = deriveMedianRuntime(study1Fe);
  const study1ReconMedians = deriveMedianRuntime(study1Recon);
  const study1FeTTQMedians = deriveMedianRuntime(study1FeTTQ);
  const study1ReconTTQMedians = deriveMedianRuntime(study1ReconTTQ);

  const feReconTTQ = generatePairwiseComparisons(
    study1FeTTQMedians,
    study1FeTTQ,
    study1ReconTTQMedians,
    study1ReconTTQ
  );
  const feRecon = generatePairwiseComparisons(
    study1FeMedians,
    study1Fe,
    study1ReconMedians,
    study1Recon
  );
  const feTTQWithReconSpeedups = generateSpeedups(
    study1FeTTQMedians,
    study1FeTTQ,
    study1ReconTTQMedians
  );
  const reconCETTQ = generateReconCETTQ(
    study1ReconTTQMedians,
    study1ReconTTQ,
    study1ReconMedians,
    study1Recon
  );

  if (!fs.existsSync(path.resolve(__dirname, "../output"))) {
    await fsPromises.mkdir(path.resolve(__dirname, "../output"));
  }

  plotFigure5(feReconTTQ);
  plotFigure6(feRecon);
  plotFigure7(feTTQWithReconSpeedups);
  plotFigure9(reconCETTQ);
}

main();
