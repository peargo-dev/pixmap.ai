import os
from redis.asyncio import Redis
from redis.asyncio.connection import ConnectionPool

# Try to load .env manually if running on host
try:
    # Find .env at project root
    root_dir = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    env_path = os.path.join(root_dir, ".env")
    if os.path.exists(env_path):
        with open(env_path, "r") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                if "=" in line:
                    k, v = line.split("=", 1)
                    k = k.strip()
                    v = v.strip().strip("'\"")
                    if k not in os.environ:
                        os.environ[k] = v
except Exception:
    pass

redis_host = os.getenv("REDIS_HOST", "localhost")
redis_port = int(os.getenv("REDIS_PORT", "6379"))
redis_db = int(os.getenv("REDIS_DB", "0"))

# Auto-route when running on host connecting to container
if redis_host == "redis" and not os.path.exists("/.dockerenv"):
    redis_host = "localhost"
    redis_port = 6380

pool = ConnectionPool(
    host=redis_host,
    port=redis_port,
    db=redis_db,
    decode_responses=False,
)

client = Redis(connection_pool=pool)
scripts = {}

scripts_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "scripts")
for filename in os.listdir(scripts_dir):
    if filename.endswith(".lua"):
        with open(os.path.join(scripts_dir, filename), "r") as f:
            script = f.read()
            scripts[filename[:-4]] = client.register_script(script)
            print("Loaded script {}".format(filename))