import numpy as np

heights = np.array([152, 160, 148, 171, 165])
print("Mean:", heights.mean())
print("Above 155:", heights[heights > 155])
