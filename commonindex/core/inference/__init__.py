"""Statistical inference, over summary statistics.

Named for what it is rather than for what it serves. `commonindex/core` may name no
collection, and `experiment` is one — the isolation guard passed only because it
inspected string literals and never a path component, which it now does. The
code was always collection-agnostic: `Arm`, `compare` and `verdict` are
arithmetic over three numbers and mention no experiment anywhere.

The readout QUERY compiler moved to `warehouse/readout.py`, next to `build.py`,
which it already borrowed `Compiled` and `quote` from.

--- what it is for ---

Experiment readouts, computed in the warehouse.

The model is the standard warehouse-native one: an experiment is an
**exposure table** joined to an **outcome**, aggregated per variation, and the
statistics run over the summary. The exposure table is the one thing a customer
must supply — who saw which variation, and when.

What this platform adds is a ratified metric. In the usual model a metric is
defined per experiment, so two experiments can measure "activation" differently
and nobody finds out. Here a readout cites a RATIFIED definition: the same
expression every dashboard uses, resolved through the same registry, refused if
nobody has stood behind it. Two experiments measuring activation measure the same
thing, by construction rather than by convention.

The exposure join needs no new machinery: a virtual dataset is a saved query, and
a saved query can contain the join. So an experiment dataset is one with a
`variation` column, and a readout is that dataset grouped by it.
"""

from __future__ import annotations

from .srm import SRM, ArmCount, check_srm
from .stats import Arm, Comparison, Readout, compare, verdict

__all__ = ["SRM", "Arm", "ArmCount", "Comparison", "Readout",
           "check_srm", "compare", "verdict"]
