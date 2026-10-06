/**
 * pyodide_bridge.js
 * RPC front-end for the engine Web Worker (engine_worker.js).
 *
 * Pyodide used to run on the main thread, which froze the whole page for the
 * duration of every solve — seconds to minutes on larger circuits. All engine
 * calls now go through a worker and return Promises; the UI keeps painting,
 * and a runaway computation can be cancelled (worker terminate + respawn).
 *
 * Every method resolves (never rejects) with the engine's parsed JSON, or with
 * {ok:false, errors:[...]} on transport-level failure — so call sites only
 * ever check result.ok. Transport failures also carry `cancelled:true` (user
 * pressed Cancel) or `superseded:true` (replaced by a newer call of the same
 * tag) so callers can stay quiet about them.
 */

const Bridge = {
    worker: null,
    isReady: false,
    initFailed: null,       // Error once init has failed for good

    // Callbacks for UI updates
    onInitComplete: null,   // (isRestart) => void
    onInitFailed: null,     // (error) => void
    onBusyChange: null,     // (busyCount) => void

    // Jobs live on THIS side and go to the worker one at a time. When the
    // worker owned the queue, every auto-solve fired by a burst of edits ran
    // to completion in order, and a plot request typed in meanwhile waited
    // behind all of them -- the graph looked frozen. Holding the queue here
    // lets a newer request of the same kind replace an older one that has not
    // started yet (see `tag`), and lets calls made while the worker restarts
    // simply wait for it instead of failing with "Engine not ready".
    _queue: [],             // [{ id, fn, args, tag, resolve }] not yet sent
    _running: null,         // the job the worker is executing, or null
    _nextId: 1,
    _isRestart: false,

    init() {
        this._spawn();
    },

    _spawn() {
        const worker = new Worker('engine_worker.js?v=8');
        this.worker = worker;

        worker.onmessage = (e) => {
            if (worker !== this.worker) return;   // a terminated worker's echo
            const msg = e.data;

            if (msg.type === 'ready') {
                this.isReady = true;
                console.log("Engine worker ready.");
                if (this.onInitComplete) this.onInitComplete(this._isRestart);
                this._notifyBusy();
                this._pump();
                return;
            }
            if (msg.type === 'init_error') {
                console.error("Engine worker init error:", msg.error);
                this.initFailed = new Error(msg.error);
                this._failAll("Engine failed to load: " + msg.error);
                if (this.onInitFailed) this.onInitFailed(this.initFailed);
                return;
            }

            const job = this._running;
            if (!job || job.id !== msg.id) return;   // cancelled / stale
            this._running = null;

            if (msg.ok) {
                try {
                    job.resolve(JSON.parse(msg.result));
                } catch (err) {
                    job.resolve({ ok: false, errors: ["Bridge error: " + err.message] });
                }
            } else {
                job.resolve({ ok: false, errors: ["Engine error: " + msg.error] });
            }
            this._notifyBusy();
            this._pump();
        };

        worker.onerror = (e) => {
            if (worker !== this.worker) return;
            // A worker-level crash fails every in-flight call; the page keeps
            // working for editing, and analysis reports the error.
            console.error("Engine worker error:", e);
            this._failAll("Engine worker crashed: " + (e.message || "unknown error"));
        };
    },

    /** Number of calls not yet answered (running + queued). */
    busyCount() {
        return this._queue.length + (this._running ? 1 : 0);
    },

    _notifyBusy() {
        if (this.onBusyChange) this.onBusyChange(this.busyCount());
    },

    _pump() {
        if (!this.isReady || this._running || this._queue.length === 0) return;
        const job = this._queue.shift();
        this._running = job;
        this.worker.postMessage({ id: job.id, fn: job.fn, args: job.args });
    },

    _failAll(message) {
        const jobs = this._running ? [this._running, ...this._queue] : [...this._queue];
        this._running = null;
        this._queue = [];
        for (const job of jobs) job.resolve({ ok: false, errors: [message], cancelled: message === "Cancelled" });
        this._notifyBusy();
    },

    /**
     * Abandon whatever the engine is doing. Pyodide cannot be interrupted
     * mid-computation without cross-origin isolation (unavailable on GitHub
     * Pages), so cancel = terminate the worker and start a fresh one. SymPy
     * reloads in the background. Everything pending -- the running call and
     * any queued behind it -- resolves as cancelled; calls made after this
     * wait for the new worker.
     */
    cancel() {
        if (!this.worker) return;
        this.worker.terminate();
        this.isReady = false;
        this._isRestart = true;
        this._spawn();
        this._failAll("Cancelled");
    },

    /**
     * Queue an engine call. `tag` (optional) names a "latest wins" lane: a new
     * call with the same tag resolves any still-QUEUED call of that tag as
     * superseded ({ok:false, superseded:true}), since its caller would discard
     * the stale result anyway. A call already running is never touched.
     */
    _enqueue(tag, fn, ...args) {
        if (this.initFailed) {
            return Promise.resolve({ ok: false, errors: ["Engine failed to load: " + this.initFailed.message] });
        }
        return new Promise((resolve) => {
            if (tag) {
                this._queue = this._queue.filter(job => {
                    if (job.tag !== tag) return true;
                    job.resolve({ ok: false, errors: ["Superseded"], superseded: true });
                    return false;
                });
            }
            this._queue.push({ id: this._nextId++, fn, args, tag, resolve });
            this._notifyBusy();
            this._pump();
        });
    },

    _call(fn, ...args) {
        return this._enqueue(null, fn, ...args);
    },

    // Same method names as the old synchronous bridge, now Promise-returning.
    parseNetlist(text) {
        return this._call('parse_netlist', text);
    },

    solveCircuit(circuitJsonObj, tag = null) {
        return this._enqueue(tag, 'solve', JSON.stringify(circuitJsonObj));
    },

    substitute(tfJsonObj, subsMapObj, tag = null) {
        return this._enqueue(tag, 'substitute', JSON.stringify(tfJsonObj), JSON.stringify(subsMapObj));
    },

    flatten(tfJsonObj) {
        return this._call('flatten', JSON.stringify(tfJsonObj));
    },

    freqResponse(tfJsonObj, rangeObj, tag = null) {
        return this._enqueue(tag, 'freq_response', JSON.stringify(tfJsonObj), JSON.stringify(rangeObj));
    },

    approximate(tfJsonObj, specObj) {
        return this._call('approximate', JSON.stringify(tfJsonObj), JSON.stringify(specObj));
    },

    polesZeros(tfJsonObj) {
        return this._call('poles_zeros', JSON.stringify(tfJsonObj));
    },

    sensitivity(tfJsonObj, targetObj, valuesObj) {
        return this._call('sensitivity',
            JSON.stringify(tfJsonObj), JSON.stringify(targetObj), JSON.stringify(valuesObj));
    }
};

// Initialize immediately on load
document.addEventListener("DOMContentLoaded", () => {
    Bridge.init();
});
