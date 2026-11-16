#define _GNU_SOURCE
#include <arpa/inet.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <unistd.h>
/* A second thread rewrites the syscall's pointer argument while the first thread is inside it. */
static struct sockaddr_in addr;
static char path[256];
static atomic_int stop;
static const char *good_path, *bad_path;
static void *flip_addr(void *u) {
  (void)u;
  volatile unsigned short *port = &addr.sin_port;
  while (!atomic_load(&stop)) { *port = htons(18081); *port = htons(18080); }
  return 0;
}
static void *flip_path(void *u) {
  (void)u;
  while (!atomic_load(&stop)) { strcpy(path, bad_path); strcpy(path, good_path); }
  return 0;
}
int main(int argc, char **argv) {
  int rounds = atoi(argv[2]);
  pthread_t t;
  int ok = 0, fail = 0;
  if (!strcmp(argv[1], "connect")) {
    addr.sin_family = AF_INET; addr.sin_port = htons(18080); addr.sin_addr.s_addr = htonl(0x7f000001);
    pthread_create(&t, 0, flip_addr, 0);
    for (int i = 0; i < rounds; i++) {
      int s = socket(AF_INET, SOCK_STREAM, 0);
      if (connect(s, (struct sockaddr *)&addr, sizeof addr) == 0) ok++; else fail++;
      close(s);
    }
  } else {
    good_path = argv[3]; bad_path = argv[4]; strcpy(path, good_path);
    pthread_create(&t, 0, flip_path, 0);
    for (int i = 0; i < rounds; i++) {
      if (chmod(path, (i & 1) ? 0777 : 0640) == 0) ok++; else fail++;
    }
  }
  atomic_store(&stop, 1); pthread_join(t, 0);
  printf("%s ok=%d fail=%d\n", argv[1], ok, fail);
  return 0;
}
