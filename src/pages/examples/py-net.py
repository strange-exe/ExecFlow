import urllib.request

page = urllib.request.urlopen("https://example.com")
print(page.status)
