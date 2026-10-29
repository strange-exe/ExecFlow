import threading

worker = threading.Thread(target=print, args=("hello from a thread",))
worker.start()
worker.join()
