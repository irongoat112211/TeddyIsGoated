import sys, json, io
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import pandas as pd

raw = sys.stdin.read()
data = json.loads(raw)
snapshots = data.get("snapshots", [])

if not snapshots:
    sys.exit(0)

df = pd.DataFrame(snapshots)
df.columns = ["timestamp", "player_count"]
df["timestamp"] = pd.to_datetime(df["timestamp"])
df = df.astype({"player_count": "int32"})
df.columns = ["Time", "Player Count"]

params = {
    "ytick.color": "w",
    "xtick.color": "w",
    "axes.labelcolor": "w",
    "axes.edgecolor": "w",
}
plt.rcParams.update(params)

fig = plt.figure(figsize=(7, 3), dpi=200)
ax = plt.axes()
plt.margins(x=0)

df.plot(ax=ax, x="Time", y="Player Count", linewidth=3.0, c="w")
ax.get_legend().remove()
ax.get_xaxis().set_visible(False)

# Ensure y-axis shows variation — always start from 0, pad above max
max_val = df["Player Count"].max()
min_val = df["Player Count"].min()
pad = max(5, (max_val - min_val) * 0.15, max_val * 0.1)
ax.set_ylim(bottom=0, top=max_val + pad)

buf = io.BytesIO()
plt.savefig(buf, transparent=True, bbox_inches="tight", format="png", pad_inches=0.1)
plt.close("all")

sys.stdout.buffer.write(buf.getvalue())
