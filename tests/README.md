# SymTF Tests

This directory contains the automated test suites for SymTF.

## Structure

*   `test_schematic.js`: Unit tests for the schematic editor's geometry and topology extraction (runs outside the DOM).
*   `test_netlist.js`: Tests for MNA matrix formulation and netlist generation.
*   `test_samples.js`: Validates the built-in sample circuits.
*   `test_dom.js`: Light DOM/UI interaction tests.
*   `test_engine.py`: Comprehensive Python tests for the symbolic engine (MNA, solving, transfer functions, Bode plots).
*   `test_speedup.py`: Tests for Python optimization routines and simplification speed.

## Running Tests

All tests can be executed sequentially using the master script in the repository root:

```bash
# Run from the repository root
bash run_tests.sh
```

### Dependencies
- **Deno**: Required to run the JavaScript test files locally without a browser environment.
- **Python & pytest**: Required to test the Python symbolic engine.
- **SymPy**: Required for the Python engine tests (`pip install sympy pytest`).
