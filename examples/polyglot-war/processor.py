import b4mal
import time

@b4mal.core_shield(["fs:write:db/local.sqlite", "fs:read:dist/app.bin"])
def process():
    print("      [Python] DataProcessor: Attesting claims...")
    time.sleep(1)
    print("      [Python] DataProcessor: Processing complete.")

if __name__ == "__main__":
    process()
